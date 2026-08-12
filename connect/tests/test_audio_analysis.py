"""Tests for core/audio_analysis.py — analyze_pcm(), should_analyze(), and
AudioAnalyzer's decode/pace/release pipeline. The subprocess itself
(spawning ffmpeg, decoding actual MP3) isn't covered here — that needs a
real ffmpeg process and is exercised manually against a live cast target
instead, same as the lyrics providers' test_lyrics_live.py. _write_input()
and _release_frames() are still covered directly though, by faking out just
_proc/_proc.stdin (for the former) or _pending/_reading_done directly (for
the latter) — _release_frames() in particular is the piece that had two
real bugs: pacing against a fixed bitrate timeline instead of the actual
calibrated playback clock (let analysis race ahead of real playback), and
being torn down the moment ffmpeg finished producing bytes rather than once
playback actually finished (ffmpeg can finish transcoding a whole track in
seconds, well before the track is done playing)."""

import asyncio
import math
import struct
from unittest.mock import AsyncMock, MagicMock

from core.audio_analysis import (
    LIVE_ANALYSIS_TARGET_TYPES,
    _BAND_COUNT,
    _FFT_SIZE,
    _SAMPLE_RATE,
    AudioAnalyzer,
    _smooth_bands,
    analyze_pcm,
    should_analyze,
)


def _tone_pcm(freq: float, n: int, sample_rate: int = _SAMPLE_RATE, amplitude: float = 0.8) -> bytes:
    samples = [
        int(amplitude * 32767 * math.sin(2 * math.pi * freq * i / sample_rate)) for i in range(n)
    ]
    return struct.pack(f"<{n}h", *samples)


# ── analyze_pcm ──────────────────────────────────────────────────────────────


def test_analyze_pcm_returns_band_count_values():
    bands = analyze_pcm(_tone_pcm(440, _FFT_SIZE))
    assert len(bands) == _BAND_COUNT


def test_analyze_pcm_values_are_normalized():
    bands = analyze_pcm(_tone_pcm(440, _FFT_SIZE, amplitude=1.0))
    assert all(0.0 <= b <= 1.0 for b in bands)


def test_analyze_pcm_silence_is_near_zero():
    silence = b"\x00\x00" * _FFT_SIZE
    bands = analyze_pcm(silence)
    assert all(b < 0.05 for b in bands)


def test_analyze_pcm_empty_input_returns_zeros():
    assert analyze_pcm(b"") == [0.0] * _BAND_COUNT


def test_analyze_pcm_louder_tone_scores_higher():
    # Guards the dB-scale normalization actually being monotonic with
    # volume — a linear ratio against the theoretical per-bin maximum (the
    # first version of this) technically was too, but compressed real
    # music's whole dynamic range down near 0, reading as much quieter
    # than the same audio through the Web Audio API's own (dB-scaled)
    # AnalyserNode does in 'local' mode.
    quiet = analyze_pcm(_tone_pcm(440, _FFT_SIZE, amplitude=0.05))
    loud = analyze_pcm(_tone_pcm(440, _FFT_SIZE, amplitude=0.9))
    assert max(loud) > max(quiet)


def test_analyze_pcm_near_full_scale_tone_reads_loud():
    # A loud, cleanly-tuned tone should land well up the scale, not the
    # near-silent reading a naive linear-to-theoretical-max ratio gave it.
    bands = analyze_pcm(_tone_pcm(440, _FFT_SIZE, amplitude=0.95))
    assert max(bands) > 0.5


def test_analyze_pcm_low_tone_peaks_a_lower_band_than_high_tone():
    # Not asserting an exact band index (the band edges are a nonlinear
    # bucketing of FFT bins, not something worth hardcoding) — just that a
    # low tone's energy shows up further toward the start of the band list
    # than a high tone's does, which is what "frequency bands" has to mean
    # for this to be a real spectrum rather than noise.
    low_bands = analyze_pcm(_tone_pcm(220, _FFT_SIZE))
    high_bands = analyze_pcm(_tone_pcm(4000, _FFT_SIZE))

    def peak_index(bands: list[float]) -> int:
        return max(range(len(bands)), key=lambda i: bands[i])

    assert peak_index(low_bands) < peak_index(high_bands)


# ── _smooth_bands ────────────────────────────────────────────────────────────


def test_smooth_bands_passes_through_on_first_frame():
    current = [0.1, 0.9, 0.5]
    assert _smooth_bands(None, current, 0.5) == current


def test_smooth_bands_blends_toward_current():
    previous = [0.0] * 4
    current = [1.0] * 4
    # time_constant=0.5 keeps half the old value, half the new one.
    assert _smooth_bands(previous, current, 0.5) == [0.5] * 4


def test_smooth_bands_higher_time_constant_reacts_slower():
    previous = [0.0]
    current = [1.0]
    slow = _smooth_bands(previous, current, 0.9)
    fast = _smooth_bands(previous, current, 0.1)
    assert slow[0] < fast[0]


def test_smooth_bands_falls_back_to_current_on_length_mismatch():
    previous = [0.5, 0.5]
    current = [1.0, 1.0, 1.0]
    assert _smooth_bands(previous, current, 0.5) == current


# ── should_analyze ────────────────────────────────────────────────────────────


def test_should_analyze_true_for_sonos():
    assert should_analyze([("sonos", "Living Room")]) is True


def test_should_analyze_true_for_dlna():
    assert should_analyze([("dlna", "Renderer")]) is True


def test_should_analyze_true_for_chromecast():
    assert should_analyze([("chromecast", "Kitchen")]) is True


def test_should_analyze_false_for_airplay_only():
    assert should_analyze([("airplay", "Living Room")]) is False


def test_should_analyze_false_for_no_targets():
    assert should_analyze([]) is False


def test_should_analyze_true_when_mixed_with_airplay():
    # Matches the frontend's own "at least one live target" check
    # (NowPlayingView.vue's visualizerAvailable) — if analysis runs at
    # all, frames get pushed regardless of what else is also playing.
    assert should_analyze([("airplay", "Bedroom"), ("sonos", "Living Room")]) is True


def test_live_analysis_target_types_excludes_airplay():
    assert "airplay" not in LIVE_ANALYSIS_TARGET_TYPES


# ── AudioAnalyzer._write_input — unthrottled, no pacing here anymore ─────────


def _fake_analyzer(elapsed_fn) -> tuple[AudioAnalyzer, list[bytes]]:
    """An AudioAnalyzer with a stand-in for the ffmpeg subprocess — records
    whatever _write_input() would have written to its stdin, without
    needing a real decoder process for these tests."""
    written: list[bytes] = []
    analyzer = AudioAnalyzer(elapsed_fn=elapsed_fn)
    analyzer._proc = MagicMock()
    analyzer._proc.stdin = MagicMock()
    analyzer._proc.stdin.write = written.append
    analyzer._proc.stdin.drain = AsyncMock()
    analyzer._proc.stdin.is_closing = MagicMock(return_value=False)
    return analyzer, written


async def test_write_input_sends_chunks_immediately_regardless_of_elapsed():
    # Decode-side feeding is deliberately unthrottled now — pacing lives at
    # the release-to-frontend end instead (_release_frames below), so
    # elapsed_fn staying at 0 must not hold anything back here.
    analyzer, written = _fake_analyzer(elapsed_fn=lambda: 0.0)
    task = asyncio.create_task(analyzer._write_input())
    try:
        analyzer.feed(b"a")
        analyzer.feed(b"b")
        analyzer.feed(b"c")
        await asyncio.sleep(0.05)
        assert written == [b"a", b"b", b"c"]
    finally:
        task.cancel()


async def test_write_input_closes_stdin_and_exits_on_finish_feeding():
    analyzer, written = _fake_analyzer(elapsed_fn=lambda: 0.0)
    task = asyncio.create_task(analyzer._write_input())
    try:
        analyzer.feed(b"a")
        analyzer.finish_feeding()
        await asyncio.wait_for(task, timeout=1.0)
        assert written == [b"a"]
        analyzer._proc.stdin.close.assert_called_once()
    finally:
        if not task.done():
            task.cancel()


async def test_feed_after_finish_feeding_is_ignored():
    analyzer, written = _fake_analyzer(elapsed_fn=lambda: 0.0)
    task = asyncio.create_task(analyzer._write_input())
    try:
        analyzer.finish_feeding()
        await asyncio.wait_for(task, timeout=1.0)
        analyzer.feed(b"late")
        await asyncio.sleep(0.05)
        assert written == []
    finally:
        if not task.done():
            task.cancel()


async def test_finish_feeding_is_idempotent():
    analyzer, _ = _fake_analyzer(elapsed_fn=lambda: 0.0)
    analyzer.finish_feeding()
    analyzer.finish_feeding()  # must not queue a second sentinel / raise
    assert analyzer._input_queue.qsize() == 1


async def test_stop_marks_finished():
    analyzer, _ = _fake_analyzer(elapsed_fn=lambda: 0.0)
    await analyzer.stop()
    assert analyzer._finished is True
    analyzer.feed(b"x")
    assert analyzer._input_queue.qsize() == 0


# ── AudioAnalyzer._release_frames — this is where pacing actually happens ────


def _some_bands() -> list[float]:
    return [0.5] * _BAND_COUNT


async def test_release_frames_sends_first_pending_frame_immediately():
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0)
    analyzer._pending.append((0.0, _some_bands()))
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.05)
        assert analyzer.frames.qsize() == 1
    finally:
        task.cancel()


async def test_release_frames_holds_back_frames_ahead_of_playback():
    # The actual bug report: analysis (decode+FFT) can run well ahead of
    # real time and used to release frames in the same bursty pattern it
    # computed them in — this is what makes delivery smooth instead,
    # regardless of how early a frame was actually computed.
    elapsed = 0.0
    analyzer = AudioAnalyzer(elapsed_fn=lambda: elapsed)
    analyzer._pending.append((0.0, _some_bands()))
    analyzer._pending.append((1.0, _some_bands()))
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.05)
        # First frame (position 0) released immediately; second (position
        # 1) must wait for elapsed_fn to actually reach it.
        assert analyzer.frames.qsize() == 1
    finally:
        task.cancel()


async def test_release_frames_releases_once_playback_catches_up():
    elapsed = 0.0
    analyzer = AudioAnalyzer(elapsed_fn=lambda: elapsed)
    analyzer._pending.append((0.0, _some_bands()))
    analyzer._pending.append((1.0, _some_bands()))
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.05)
        assert analyzer.frames.qsize() == 1

        elapsed = 1.0
        await asyncio.sleep(0.6)  # release loop polls in <=0.5s steps
        assert analyzer.frames.qsize() == 2
    finally:
        task.cancel()


async def test_release_frames_exits_once_drained_and_reading_done():
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0)
    analyzer._pending.append((0.0, _some_bands()))
    analyzer._reading_done = True  # decoding already finished
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.wait_for(task, timeout=1.0)
        assert analyzer.frames.qsize() == 1
    finally:
        if not task.done():
            task.cancel()


async def test_release_frames_waits_for_more_pending_if_not_reading_done():
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0)
    # Nothing pending yet, decoding still in progress — must not exit.
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.1)
        assert not task.done()
        assert analyzer.frames.qsize() == 0
    finally:
        task.cancel()
