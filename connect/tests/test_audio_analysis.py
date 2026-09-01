"""Tests for core/audio_analysis.py — analyze_pcm(), should_analyze(), and
AudioAnalyzer's decode/pace/release pipeline. The subprocess itself
(spawning ffmpeg, decoding a real file) isn't covered here — that needs a
real ffmpeg process and is exercised manually against a live cast target
instead, same as the lyrics providers' test_lyrics_live.py. _read_pcm() and
_release_frames() are still covered directly though, by faking out
_proc.stdout (for the former) or _pending/_reading_done (for the latter) —
_release_frames() in particular is the piece that had two real bugs: pacing
against a fixed bitrate timeline instead of the actual calibrated playback
clock (let analysis race ahead of real playback), and being torn down the
moment ffmpeg finished producing bytes rather than once playback actually
finished. When analysis starts is core/visualizer_feed.py's job, and is
covered by test_visualizer_feed.py instead."""

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
    _MAX_LATENESS_SECONDS,
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


def _tone_pcm(
    freq: float, n: int, sample_rate: int = _SAMPLE_RATE, amplitude: float = 0.8
) -> bytes:
    samples = [
        int(amplitude * 32767 * math.sin(2 * math.pi * freq * i / sample_rate)) for i in range(n)
    ]
    return struct.pack(f"<{n}h", *samples)


# ── _decode_cmd ──────────────────────────────────────────────────────────────
# The analyzer decodes the media server's own copy of the track rather than
# the bytes on their way to the device (see the module docstring in
# core/audio_analysis.py), which is what makes starting mid-track possible
# at all — so what these cover is that the seek and the ReplayGain the real
# stream carries actually land in the built command.


def test_decode_cmd_seeks_to_the_start_offset_before_the_input():
    cmd = _decode_cmd("http://media/track.flac", 91.5, 1.0)
    assert cmd[cmd.index("-ss") + 1] == "91.500"
    assert cmd.index("-ss") < cmd.index("-i")


def test_decode_cmd_omits_the_seek_when_starting_from_the_beginning():
    cmd = _decode_cmd("http://media/track.flac", 0.0, 1.0)
    assert "-ss" not in cmd


def test_decode_cmd_applies_replaygain_when_the_stream_carries_it():
    cmd = _decode_cmd("http://media/track.flac", 0.0, 0.7)
    assert cmd[cmd.index("-af") + 1] == "volume=0.7"


def test_decode_cmd_omits_the_volume_filter_at_unity_gain():
    cmd = _decode_cmd("http://media/track.flac", 0.0, 1.0)
    assert "-af" not in cmd


def test_decode_cmd_reads_the_source_url_and_writes_mono_pcm_to_stdout():
    cmd = _decode_cmd("http://media/track.flac", 0.0, 1.0)
    assert cmd[cmd.index("-i") + 1] == "http://media/track.flac"
    assert cmd[cmd.index("-ac") + 1] == "1"
    assert cmd[cmd.index("-ar") + 1] == str(_SAMPLE_RATE)
    assert cmd[-3:] == ["-f", "s16le", "pipe:1"]


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


def test_should_analyze_true_for_airplay_only():
    # AirPlay streams incrementally now (see the module docstring's
    # fixed-airplay-silent-death reference) and this module never taps the
    # device-bound bytes anyway, so its fixed-estimate clock only has to
    # seek a fresh decoder close enough — same as it already does for
    # AirPlay's lyrics sync.
    assert should_analyze([("airplay", "Living Room")]) is True


def test_should_analyze_false_for_no_targets():
    assert should_analyze([]) is False


def test_should_analyze_true_when_mixed_with_airplay():
    # Matches the frontend's own "at least one live target" check
    # (NowPlayingView.vue's visualizerAvailable) — if analysis runs at
    # all, frames get pushed regardless of what else is also playing. No
    # longer a distinguishing case now that AirPlay alone is also True (see
    # test_should_analyze_true_for_airplay_only above), but still worth its
    # own assertion since the mixed-target behavior itself isn't obvious
    # from either single-target test.
    assert should_analyze([("airplay", "Bedroom"), ("sonos", "Living Room")]) is True


def test_live_analysis_target_types_includes_airplay():
    assert "airplay" in LIVE_ANALYSIS_TARGET_TYPES


# ── AudioAnalyzer._release_frames — this is where pacing actually happens ────


def _some_bands() -> list[float]:
    return [0.5] * _BAND_COUNT


async def test_release_frames_sends_first_pending_frame_immediately():
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_url="http://media/track.flac")
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
    analyzer = AudioAnalyzer(elapsed_fn=lambda: elapsed, source_url="http://media/track.flac")
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
    analyzer = AudioAnalyzer(elapsed_fn=lambda: elapsed, source_url="http://media/track.flac")
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
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_url="http://media/track.flac")
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
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_url="http://media/track.flac")
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
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_url="http://media/track.flac")
    analyzer._pending.append((0.0, _some_bands()))
    analyzer._pending.append((_PREBUFFER_SECONDS, _some_bands()))
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.1)
        assert analyzer.frames.qsize() == 1
    finally:
        task.cancel()


async def test_release_frames_waits_for_more_pending_if_not_reading_done():
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_url="http://media/track.flac")
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
    # A stand-in playback position the test moves along by hand, so each
    # frame comes due (but never falls stale — see _MAX_LATENESS_SECONDS)
    # exactly when this says so.
    position = [0.0]
    analyzer = AudioAnalyzer(elapsed_fn=lambda: position[0], source_url="http://media/track.flac")
    analyzer._pending.append((0.0, _some_bands()))
    analyzer._pending.append((_PREBUFFER_SECONDS, _some_bands()))
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.1)
        assert analyzer.frames.qsize() == 1  # the second frame isn't due yet

        position[0] = _PREBUFFER_SECONDS
        await asyncio.sleep(_PREBUFFER_SECONDS + 0.1)
        assert analyzer.frames.qsize() == 2  # pending has now drained fully

        analyzer._pending.append((_PREBUFFER_SECONDS, _some_bands()))
        await asyncio.sleep(0.1)
        assert analyzer.frames.qsize() == 3
        assert not task.done()  # still polling, not exited
    finally:
        task.cancel()


async def test_release_frames_drops_the_oldest_frame_once_the_output_queue_is_full():
    """A client that stops reading its SSE connection (a stalled browser
    tab, say) is what fills this up — every frame here is due at the same
    moment, so pacing holds none of them back."""
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 10.0, source_url="http://media/track.flac")
    for i in range(10):
        analyzer._pending.append((10.0, [float(i)] * _BAND_COUNT))
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


async def test_release_frames_drops_frames_playback_has_already_passed():
    """What an analyzer started mid-track produces first: frames for a
    position playback moved past while ffmpeg was still spinning up. Sending
    them would flush a backlog at the frontend as fast as it can take it —
    a visible stutter — before finally landing in sync. See
    _MAX_LATENESS_SECONDS."""
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 30.0, source_url="http://media/track.flac")
    analyzer._pending.append((29.0, [1.0] * _BAND_COUNT))  # a second late
    analyzer._pending.append((30.0 - _MAX_LATENESS_SECONDS / 2, [2.0] * _BAND_COUNT))
    analyzer._reading_done = True
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.wait_for(task, timeout=1.0)
        # Only the barely-late one — still current enough to be worth
        # showing — actually goes out.
        assert [f[0] for f in list(analyzer.frames._queue)] == [2.0]
    finally:
        if not task.done():
            task.cancel()


# ── AudioAnalyzer.start() ────────────────────────────────────────────────────


async def test_start_creates_the_decoder_process_and_its_background_tasks():
    fake_proc = MagicMock()
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_url="http://media/track.flac")
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=fake_proc)):
        await analyzer.start()
    try:
        assert analyzer._proc is fake_proc
        assert analyzer._reader_task is not None
        assert analyzer._release_task is not None
    finally:
        analyzer._reader_task.cancel()
        analyzer._release_task.cancel()


async def test_start_passes_the_source_and_position_to_ffmpeg():
    exec_mock = AsyncMock(return_value=MagicMock())
    analyzer = AudioAnalyzer(
        elapsed_fn=lambda: 0.0,
        source_url="http://media/track.flac",
        start_offset=42.0,
        gain=0.5,
    )
    with patch("asyncio.create_subprocess_exec", exec_mock):
        await analyzer.start()
    try:
        cmd = list(exec_mock.await_args.args)
        assert cmd[cmd.index("-i") + 1] == "http://media/track.flac"
        assert cmd[cmd.index("-ss") + 1] == "42.000"
        assert cmd[cmd.index("-af") + 1] == "volume=0.5"
        # Frames are tagged from where the decode actually starts, not from
        # the track's beginning — that's what keeps a mid-track start in
        # sync with playback.
        assert analyzer._pcm_position == 42.0
    finally:
        analyzer._reader_task.cancel()
        analyzer._release_task.cancel()


async def test_start_logs_and_leaves_no_tasks_when_ffmpeg_is_missing(caplog):
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_url="http://media/track.flac")
    with (
        patch("asyncio.create_subprocess_exec", AsyncMock(side_effect=FileNotFoundError)),
        caplog.at_level(logging.WARNING, logger="connect.audio_analysis"),
    ):
        await analyzer.start()

    assert "ffmpeg not found" in caplog.text
    assert analyzer._reader_task is None
    assert analyzer._release_task is None


async def test_start_with_a_pcm_source_never_spawns_ffmpeg():
    """core/visualizer_feed.py's radio branch — reads from an already-open
    PCM stream (core/radio_relay.py's RadioRelay) instead of decoding a
    track a second time."""
    pcm_source = MagicMock()
    pcm_source.read = AsyncMock(return_value=b"")
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, pcm_source=pcm_source)
    exec_mock = AsyncMock()

    with patch("asyncio.create_subprocess_exec", exec_mock):
        await analyzer.start()
    try:
        exec_mock.assert_not_awaited()
        assert analyzer._proc is None
        assert analyzer._reader_task is not None
        assert analyzer._release_task is not None
    finally:
        analyzer._reader_task.cancel()
        analyzer._release_task.cancel()


async def test_read_pcm_reads_from_the_given_pcm_source_when_present():
    pcm = _tone_pcm(440, _FFT_SIZE)
    pcm_source = MagicMock()
    pcm_source.read = AsyncMock(side_effect=[pcm, b""])
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, pcm_source=pcm_source)

    await analyzer._read_pcm()

    assert analyzer._pending  # produced at least one frame, straight from pcm_source


# ── AudioAnalyzer._read_pcm — decode/FFT/windowing ───────────────────────────


def _fake_analyzer_with_stdout(elapsed_fn, stdout_chunks) -> AudioAnalyzer:
    """Same idea as _fake_analyzer() above but for the read side — a
    stand-in for the decoder's stdout, so _read_pcm()'s own buffering/
    windowing/pacing logic is directly testable without a real ffmpeg
    process (see the module docstring: actual MP3 decoding correctness
    itself still isn't covered here, only the Python logic around it)."""
    analyzer = AudioAnalyzer(elapsed_fn=elapsed_fn, source_url="http://media/track.flac")
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


async def test_stop_cancels_both_background_tasks_and_kills_the_process():
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_url="http://media/track.flac")
    analyzer._proc = MagicMock()

    async def _never_ending():
        await asyncio.sleep(1000)

    analyzer._reader_task = asyncio.create_task(_never_ending())
    analyzer._release_task = asyncio.create_task(_never_ending())
    await asyncio.sleep(0)  # let them actually start before stopping them

    await analyzer.stop()
    await asyncio.sleep(0)  # let the requested cancellation actually land

    assert analyzer._reader_task.cancelled()
    assert analyzer._release_task.cancelled()
    analyzer._proc.kill.assert_called_once()


async def test_stop_swallows_the_process_already_being_gone():
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_url="http://media/track.flac")
    analyzer._proc = MagicMock()
    analyzer._proc.kill = MagicMock(side_effect=ProcessLookupError())

    await analyzer.stop()  # must not raise


async def test_stop_is_safe_before_start_ever_ran():
    """ffmpeg missing (see start()) leaves no process and no tasks — the
    supervisor still stops it like any other analyzer."""
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_url="http://media/track.flac")

    await analyzer.stop()  # must not raise


async def test_stop_calls_cleanup_exactly_once_even_if_stop_runs_twice():
    """core/visualizer_feed.py's radio branch relies on this to unsubscribe
    from core/radio_relay.py's RadioRelay — called more than once would
    double-remove (harmless there, since RadioRelay.unsubscribe_pcm() is
    itself idempotent) but is still worth pinning down as exactly-once."""
    cleanup = MagicMock()
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, pcm_source=MagicMock(), cleanup=cleanup)

    await analyzer.stop()
    await analyzer.stop()

    cleanup.assert_called_once()
