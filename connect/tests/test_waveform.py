"""Tests for core/waveform.py — _compute_peaks() and get_waveform()."""

import array
import logging
import math
import struct
import time
from unittest.mock import AsyncMock, patch

from core import waveform
from core.waveform import _PEAK_COUNT, _compute_peaks


def _tone_pcm(freq: float, n: int, sample_rate: int = 11025, amplitude: float = 0.8) -> bytes:
    samples = [
        int(amplitude * 32767 * math.sin(2 * math.pi * freq * i / sample_rate)) for i in range(n)
    ]
    return struct.pack(f"<{n}h", *samples)


# ── _compute_peaks ────────────────────────────────────────────────────────────


def test_compute_peaks_returns_peak_count_values():
    peaks = _compute_peaks(_tone_pcm(440, _PEAK_COUNT * 10))
    assert len(peaks) == _PEAK_COUNT


def test_compute_peaks_empty_input_returns_zeros():
    assert _compute_peaks(b"") == [0.0] * _PEAK_COUNT


def test_compute_peaks_silence_is_zero():
    silence = b"\x00\x00" * (_PEAK_COUNT * 10)
    assert _compute_peaks(silence) == [0.0] * _PEAK_COUNT


def test_compute_peaks_values_are_normalized():
    peaks = _compute_peaks(_tone_pcm(440, _PEAK_COUNT * 10))
    assert all(0.0 <= p <= 1.0 for p in peaks)


def test_compute_peaks_normalizes_against_own_loudest_bucket():
    # A quiet tone should still reach 1.0 somewhere — normalization is
    # relative to this track's own loudest bucket, not a fixed theoretical
    # max, so quiet tracks still use the full visual height.
    peaks = _compute_peaks(_tone_pcm(440, _PEAK_COUNT * 10, amplitude=0.05))
    assert max(peaks) == 1.0


def test_compute_peaks_louder_region_reads_higher():
    # Build PCM where the second half is much louder than the first —
    # buckets covering the loud half should read higher than the quiet half.
    n = _PEAK_COUNT * 10
    quiet = _tone_pcm(440, n // 2, amplitude=0.05)
    loud = _tone_pcm(440, n // 2, amplitude=0.9)
    peaks = _compute_peaks(quiet + loud)
    first_half_max = max(peaks[: _PEAK_COUNT // 2])
    second_half_max = max(peaks[_PEAK_COUNT // 2 :])
    assert second_half_max > first_half_max


def test_compute_peaks_handles_odd_byte_length():
    # One trailing stray byte (not a full 16-bit sample) shouldn't crash —
    # just gets dropped.
    pcm = _tone_pcm(440, _PEAK_COUNT * 10) + b"\x00"
    peaks = _compute_peaks(pcm)
    assert len(peaks) == _PEAK_COUNT


def test_compute_peaks_fewer_samples_than_buckets():
    # Shorter than _PEAK_COUNT samples — some buckets end up empty (0.0)
    # rather than raising.
    peaks = _compute_peaks(_tone_pcm(440, 10))
    assert len(peaks) == _PEAK_COUNT


def test_compute_peaks_round_trips_signed_16_bit_samples():
    # Sanity check the conversion path actually round-trips signed 16-bit
    # samples correctly (not e.g. mis-signed or byte-swapped).
    raw = array.array("h", [32767, -32768] * ((_PEAK_COUNT * 10) // 2)).tobytes()
    peaks = _compute_peaks(raw)
    assert max(peaks) == 1.0


def test_compute_peaks_does_not_wrap_on_the_int16_minimum():
    """-(-32768) does not fit in an int16. Reducing a bucket and negating
    it without widening first wraps the value straight back to -32768, so a
    full-scale negative peak would read as silence — a trap the previous,
    Python-int implementation could not hit but a vectorized one can."""
    quiet, loud = 100, -32768
    samples = [quiet] * (_PEAK_COUNT * 10)
    samples[: 10] = [loud] * 10  # the first bucket is full-scale negative
    peaks = _compute_peaks(array.array("h", samples).tobytes())
    assert peaks[0] == 1.0
    assert peaks[-1] < 0.01


def test_compute_peaks_folds_an_uneven_remainder_into_the_last_bucket():
    """Sample counts rarely divide evenly by _PEAK_COUNT. The leftover tail
    belongs to the final bucket rather than being dropped, so a peak living
    in the last fraction of a second still shows up."""
    n = _PEAK_COUNT * 10 + 7  # 7 samples that don't fill a whole bucket
    samples = [100] * n
    samples[-1] = 32767  # the loudest sample is inside that remainder
    peaks = _compute_peaks(array.array("h", samples).tobytes())
    assert peaks[-1] == 1.0


def test_compute_peaks_is_vectorized_not_per_sample():
    """Regression guard for a real prod bug (beacon-dev 2026-08-22): the
    previous implementation used max()/min() over array.array slices, which
    iterate via the iterator protocol and box every sample into a Python
    int. An 80-minute DJ mix (52.8M samples) took 2.53s that way — and
    because boxing ints holds the GIL, the caller's asyncio.to_thread()
    hop could not stop it blocking the event loop, starving the casting
    device's open /stream socket for that whole time.

    Calibrated against a boxed pass over the same data rather than a fixed
    wall-clock bound, so this measures the *approach* and not how fast the
    machine running it happens to be — no flakiness on a loaded CI box."""
    n = 1_000_000
    samples = array.array("h", [(i * 7919) % 30000 - 15000 for i in range(n)])
    pcm = samples.tobytes()

    start = time.perf_counter()
    max(samples), min(samples)  # exactly what the old version did, once
    boxed = time.perf_counter() - start

    start = time.perf_counter()
    _compute_peaks(pcm)
    actual = time.perf_counter() - start

    assert actual * 5 < boxed, (
        f"_compute_peaks took {actual*1000:.1f}ms vs {boxed*1000:.1f}ms for a single "
        "boxed pass — it looks per-sample again, which will block the event loop"
    )


# ── get_waveform ─────────────────────────────────────────────────────────────


async def test_get_waveform_returns_empty_when_ffmpeg_missing():
    with patch("asyncio.create_subprocess_exec", side_effect=FileNotFoundError):
        result = await waveform.get_waveform("track-1", "http://example/track")
        assert result == []


async def test_get_waveform_decodes_every_call_not_just_once():
    # No caching (on demand only, by design — see the module docstring) —
    # two calls for the same track must each spawn a fresh decode.
    with patch("asyncio.create_subprocess_exec", side_effect=FileNotFoundError) as mock_exec:
        await waveform.get_waveform("track-1", "http://example/track")
        await waveform.get_waveform("track-1", "http://example/track")
        assert mock_exec.call_count == 2


class _FakeWaveformProc:
    def __init__(
        self,
        stdout: bytes = b"",
        stderr: bytes = b"",
        returncode: int = 0,
        communicate_error: BaseException | None = None,
        wait_error: BaseException | None = None,
    ):
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr
        self._communicate_error = communicate_error
        self._wait_error = wait_error
        self.killed = False

    async def communicate(self):
        if self._communicate_error:
            raise self._communicate_error
        return self._stdout, self._stderr

    def kill(self) -> None:  # real Process.kill() is synchronous, not awaited
        self.killed = True

    async def wait(self):
        if self._wait_error:
            raise self._wait_error


async def test_get_waveform_returns_computed_peaks_on_success():
    pcm = _tone_pcm(440, _PEAK_COUNT * 10)
    proc = _FakeWaveformProc(stdout=pcm, returncode=0)

    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
        result = await waveform.get_waveform("track-1", "http://example/track")

    assert result == _compute_peaks(pcm)


async def test_get_waveform_returns_empty_on_a_nonzero_ffmpeg_exit(caplog):
    proc = _FakeWaveformProc(stderr=b"Invalid data found when processing input", returncode=1)

    with (
        patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)),
        caplog.at_level(logging.WARNING, logger="connect.waveform"),
    ):
        result = await waveform.get_waveform("track-1", "http://example/track")

    assert result == []
    assert "Invalid data found" in caplog.text


async def test_get_waveform_kills_the_process_and_returns_empty_on_a_stalled_decode():
    """Guards against a stalled/broken source stream hanging the request
    forever — see _DECODE_TIMEOUT_SECONDS's own comment."""
    proc = _FakeWaveformProc(communicate_error=TimeoutError())

    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
        result = await waveform.get_waveform("track-1", "http://example/track")

    assert result == []
    assert proc.killed is True


def test_waveform_endpoint_returns_peaks(client, default_session):
    """routes/waveform.py's GET /waveform/{track_id} — thin HTTP wrapper
    around core/waveform.get_waveform(), tested everywhere else above."""
    pcm = _tone_pcm(440, _PEAK_COUNT * 10)
    default_session.media.get_stream_url = lambda track_id: "http://nav/stream?id=" + track_id
    proc = _FakeWaveformProc(stdout=pcm, returncode=0)

    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
        r = client.get("/waveform/track-1")

    assert r.status_code == 200
    assert r.json()["peaks"] == _compute_peaks(pcm)


async def test_get_waveform_logs_when_the_killed_process_wont_exit_either(caplog):
    """The kill()-then-reap wait must never itself hang the request — bounded
    by its own 5s timeout, logged (not raised) if even that isn't enough."""
    proc = _FakeWaveformProc(
        communicate_error=TimeoutError(), wait_error=TimeoutError()
    )

    with (
        patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)),
        caplog.at_level(logging.WARNING, logger="connect.waveform"),
    ):
        result = await waveform.get_waveform("track-1", "http://example/track")

    assert result == []
    assert "didn't exit after kill" in caplog.text
