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
import logging
import math
import struct
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.audio_analysis import (
    _BAND_COUNT,
    _FFT_SIZE,
    _FRAME_SECONDS,
    _HOP_SIZE,
    _MAX_LOOKAHEAD_SECONDS,
    _PREBUFFER_SECONDS,
    _SAMPLE_RATE,
    LIVE_ANALYSIS_TARGET_TYPES,
    AudioAnalyzer,
    _decode_cmd,
    _smooth_bands,
    analyze_pcm,
    should_analyze,
)


def _tone_pcm(freq: float, n: int, sample_rate: int = _SAMPLE_RATE, amplitude: float = 0.8) -> bytes:
    samples = [
        int(amplitude * 32767 * math.sin(2 * math.pi * freq * i / sample_rate)) for i in range(n)
    ]
    return struct.pack(f"<{n}h", *samples)


# ── _decode_cmd ──────────────────────────────────────────────────────────────
# Regression tests: this used to be a fixed command hardcoding "-f mp3" —
# see core/streamer.py's demuxer_for() for the full story (GET /visualizer
# silently never produced frames for a flac/aac/ogg-sourced track cast to
# Sonos/DLNA/Chromecast). The subprocess itself isn't exercised here (see
# this module's own docstring), just that the input_format actually lands
# in the built command where ffmpeg expects an input format flag.


def test_decode_cmd_uses_given_input_format():
    cmd = _decode_cmd("flac")
    assert cmd[cmd.index("-f") + 1] == "flac"


def test_decode_cmd_reads_from_stdin_and_writes_pcm_to_stdout():
    cmd = _decode_cmd("mp3")
    assert cmd[cmd.index("-i") + 1] == "pipe:0"
    assert cmd[-3:] == ["-f", "s16le", "pipe:1"]


def test_audio_analyzer_defaults_input_format_to_mp3():
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0)
    assert analyzer._input_format == "mp3"


def test_audio_analyzer_stores_given_input_format():
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, input_format="flac")
    assert analyzer._input_format == "flac"


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


def test_analyze_pcm_pads_input_shorter_than_fft_size():
    # Far short of a full window — _read_pcm() only ever calls this once its
    # sliding buffer holds a full window, but analyze_pcm() itself is meant
    # to tolerate less (see its own docstring): zero-padded rather than
    # raising or reading past the buffer.
    short_pcm = _tone_pcm(440, 100)
    bands = analyze_pcm(short_pcm)
    assert len(bands) == _BAND_COUNT


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
    # Prebuffering (see test_release_frames_waits_for_prebuffer_*  below) is
    # a separate concern from the pacing this test covers — mark decoding
    # already finished so _release_frames() skips straight to pacing.
    analyzer._reading_done = True
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
    analyzer._reading_done = True  # bypass prebuffering — not this test's concern
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
    analyzer._reading_done = True  # bypass prebuffering — not this test's concern
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


async def test_release_frames_withholds_everything_until_prebuffer_fills():
    # A single frame at position 0 with decoding still in progress is
    # exactly the "just started, decode hasn't built a lead yet" case
    # _PREBUFFER_SECONDS exists for — nothing should go out yet.
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0)
    analyzer._pending.append((0.0, _some_bands()))
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.1)
        assert analyzer.frames.qsize() == 0
    finally:
        task.cancel()


async def test_release_frames_releases_once_prebuffer_fills():
    # Once _pending's own span reaches _PREBUFFER_SECONDS, the earliest
    # frame(s) should start going out even though decoding is still ongoing.
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0)
    analyzer._pending.append((0.0, _some_bands()))
    analyzer._pending.append((_PREBUFFER_SECONDS, _some_bands()))
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.1)
        assert analyzer.frames.qsize() == 1
    finally:
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


async def test_release_frames_keeps_polling_after_pending_drains_mid_stream():
    """Distinct from the prebuffer-wait test above: here the prebuffer is
    already satisfied and pending has genuinely drained down to nothing
    with decoding still in progress — the *second* loop's own wait, not
    the first's."""
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 100.0)  # always "caught up"
    analyzer._pending.append((0.0, _some_bands()))
    analyzer._pending.append((_PREBUFFER_SECONDS, _some_bands()))
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.1)
        assert analyzer.frames.qsize() == 2  # both already-pending frames drained

        analyzer._pending.append((0.0, _some_bands()))
        await asyncio.sleep(0.1)
        assert analyzer.frames.qsize() == 3
        assert not task.done()  # still polling, not exited
    finally:
        task.cancel()


async def test_release_frames_drops_the_oldest_frame_once_the_output_queue_is_full():
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 100.0)  # always "caught up"
    for i in range(10):
        analyzer._pending.append((float(i), [float(i)] * _BAND_COUNT))
    analyzer._reading_done = True
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.wait_for(task, timeout=1.0)
        assert analyzer.frames.qsize() == 8  # capped at maxsize
        released_markers = [analyzer.frames.get_nowait()[0] for _ in range(8)]
        # The two oldest (i=0, i=1) were dropped to make room for the rest —
        # always show the freshest data, not stale history.
        assert released_markers == [2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]
    finally:
        if not task.done():
            task.cancel()


# ── AudioAnalyzer.start() / feed()'s overflow guard ──────────────────────────


async def test_start_creates_the_decoder_process_and_its_three_background_tasks():
    fake_proc = MagicMock()
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0)
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=fake_proc)):
        await analyzer.start()
    try:
        assert analyzer._proc is fake_proc
        assert analyzer._reader_task is not None
        assert analyzer._writer_task is not None
        assert analyzer._release_task is not None
    finally:
        analyzer._reader_task.cancel()
        analyzer._writer_task.cancel()
        analyzer._release_task.cancel()


async def test_start_logs_and_leaves_no_tasks_when_ffmpeg_is_missing(caplog):
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0)
    with (
        patch("asyncio.create_subprocess_exec", AsyncMock(side_effect=FileNotFoundError)),
        caplog.at_level(logging.WARNING, logger="connect.audio_analysis"),
    ):
        await analyzer.start()

    assert "ffmpeg not found" in caplog.text
    assert analyzer._reader_task is None
    assert analyzer._writer_task is None
    assert analyzer._release_task is None


async def test_feed_swallows_a_full_input_queue():
    """Deliberately unbounded in production (see the queue's own comment) —
    this drives it artificially full to exercise the defensive guard, not
    something that happens in practice."""
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0)
    analyzer._proc = MagicMock()
    analyzer._input_queue = asyncio.Queue(maxsize=1)
    analyzer._input_queue.put_nowait(b"already-queued")

    analyzer.feed(b"overflow")  # must not raise

    assert analyzer._input_queue.qsize() == 1


# ── AudioAnalyzer._write_input — failure handling ────────────────────────────


async def test_write_input_silently_swallows_a_broken_pipe():
    """A device/connection dropping mid-stream is routine, not worth a log
    line of its own — routes/stream.py's own handling above this already
    covers the user-facing side of a dropped connection."""
    analyzer, _ = _fake_analyzer(elapsed_fn=lambda: 0.0)
    analyzer._proc.stdin.write = MagicMock(side_effect=BrokenPipeError())
    task = asyncio.create_task(analyzer._write_input())
    try:
        analyzer.feed(b"a")
        await asyncio.wait_for(task, timeout=1.0)  # must not raise
    finally:
        if not task.done():
            task.cancel()


async def test_write_input_logs_an_unexpected_error(caplog):
    analyzer, _ = _fake_analyzer(elapsed_fn=lambda: 0.0)
    analyzer._proc.stdin.write = MagicMock(side_effect=RuntimeError("disk full"))
    task = asyncio.create_task(analyzer._write_input())
    try:
        with caplog.at_level(logging.WARNING, logger="connect.audio_analysis"):
            analyzer.feed(b"a")
            await asyncio.wait_for(task, timeout=1.0)
    finally:
        if not task.done():
            task.cancel()

    assert "writer stopped" in caplog.text


# ── AudioAnalyzer._read_pcm — decode/FFT/windowing ───────────────────────────


def _fake_analyzer_with_stdout(elapsed_fn, stdout_chunks) -> AudioAnalyzer:
    """Same idea as _fake_analyzer() above but for the read side — a
    stand-in for the decoder's stdout, so _read_pcm()'s own buffering/
    windowing/pacing logic is directly testable without a real ffmpeg
    process (see the module docstring: actual MP3 decoding correctness
    itself still isn't covered here, only the Python logic around it)."""
    analyzer = AudioAnalyzer(elapsed_fn=elapsed_fn)
    analyzer._proc = MagicMock()
    analyzer._proc.stdout = MagicMock()
    analyzer._proc.stdout.read = AsyncMock(side_effect=list(stdout_chunks))
    return analyzer


async def test_read_pcm_produces_one_frame_from_exactly_one_window():
    pcm = _tone_pcm(440, _FFT_SIZE)
    analyzer = _fake_analyzer_with_stdout(elapsed_fn=lambda: 0.0, stdout_chunks=[pcm, b""])

    await analyzer._read_pcm()

    assert len(analyzer._pending) == 1
    position, bands = analyzer._pending[0]
    assert position == 0.0
    assert len(bands) == _BAND_COUNT
    assert analyzer._reading_done is True


async def test_read_pcm_advances_position_by_one_frame_per_hop():
    n_samples = _FFT_SIZE + 2 * _HOP_SIZE  # one full window plus two more hops
    pcm = _tone_pcm(440, n_samples)
    analyzer = _fake_analyzer_with_stdout(elapsed_fn=lambda: 0.0, stdout_chunks=[pcm, b""])

    await analyzer._read_pcm()

    positions = [p for p, _ in analyzer._pending]
    assert positions == pytest.approx([0.0, _FRAME_SECONDS, 2 * _FRAME_SECONDS])


async def test_read_pcm_pauses_once_decoding_gets_too_far_ahead_of_playback():
    # Enough hops to push _pcm_position well past _MAX_LOOKAHEAD_SECONDS
    # while elapsed_fn stays frozen at 0 — decode racing ahead of real
    # playback (ffmpeg's transcode is CPU-bound, not real-time) is exactly
    # what this guards against, see _MAX_LOOKAHEAD_SECONDS's own comment.
    lead_hops = int(_MAX_LOOKAHEAD_SECONDS / _FRAME_SECONDS) + 10
    n_samples = _FFT_SIZE + lead_hops * _HOP_SIZE
    pcm = _tone_pcm(440, n_samples)
    analyzer = _fake_analyzer_with_stdout(elapsed_fn=lambda: 0.0, stdout_chunks=[pcm, b""])

    with patch("asyncio.sleep", new=AsyncMock()) as sleep_mock:
        await analyzer._read_pcm()

    assert sleep_mock.await_count >= 1
    assert sleep_mock.await_args.args[0] > 0


async def test_read_pcm_swallows_cancellation():
    analyzer = _fake_analyzer_with_stdout(
        elapsed_fn=lambda: 0.0, stdout_chunks=[asyncio.CancelledError()]
    )

    await analyzer._read_pcm()  # must not raise

    assert analyzer._reading_done is True


async def test_read_pcm_logs_an_unexpected_error(caplog):
    analyzer = _fake_analyzer_with_stdout(
        elapsed_fn=lambda: 0.0, stdout_chunks=[RuntimeError("decoder crashed")]
    )

    with caplog.at_level(logging.WARNING, logger="connect.audio_analysis"):
        await analyzer._read_pcm()

    assert "reader stopped" in caplog.text
    assert analyzer._reading_done is True


# ── AudioAnalyzer.stop() — immediate teardown ────────────────────────────────


async def test_stop_cancels_all_three_background_tasks_and_kills_the_process():
    analyzer, _ = _fake_analyzer(elapsed_fn=lambda: 0.0)

    async def _never_ending():
        await asyncio.sleep(1000)

    analyzer._writer_task = asyncio.create_task(_never_ending())
    analyzer._reader_task = asyncio.create_task(_never_ending())
    analyzer._release_task = asyncio.create_task(_never_ending())
    await asyncio.sleep(0)  # let them actually start before stopping them

    await analyzer.stop()
    await asyncio.sleep(0)  # let the requested cancellation actually land

    assert analyzer._writer_task.cancelled()
    assert analyzer._reader_task.cancelled()
    assert analyzer._release_task.cancelled()
    analyzer._proc.kill.assert_called_once()


async def test_stop_swallows_the_process_already_being_gone():
    analyzer, _ = _fake_analyzer(elapsed_fn=lambda: 0.0)
    analyzer._proc.kill = MagicMock(side_effect=ProcessLookupError())

    await analyzer.stop()  # must not raise
