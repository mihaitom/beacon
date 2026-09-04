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

import core.audio_analysis as audio_analysis_mod
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


async def test_release_frames_last_release_debug_is_none_without_a_cast_clock():
    """No cast clock at all — last_release_debug stays None regardless of
    what's playing. Nothing currently constructs an AudioAnalyzer this way
    (both VisualizerFeed call sites pass debug_cast_elapsed_fn now), but the
    parameter stays optional — see AudioAnalyzer's own docstring."""
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_url="http://media/track.flac")
    analyzer._pending.append((0.0, _some_bands()))
    analyzer._reading_done = True
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.05)
        assert analyzer.last_release_debug is None
    finally:
        task.cancel()


async def test_release_frames_sets_last_release_debug_when_given_a_cast_clock():
    """GET /visualizer's debug overlay — see AudioAnalyzer's own docstring
    on debug_cast_elapsed_fn. For a track both clocks are already
    track-absolute, so neither is re-based and agreeing clocks read as 0."""
    cast_elapsed = 45.0
    analyzer = AudioAnalyzer(
        elapsed_fn=lambda: 45.0,
        source_url="http://media/track.flac",
        start_offset=45.0,  # opened 45s into an already-playing track
        debug_cast_elapsed_fn=lambda: cast_elapsed,
    )
    analyzer._pending.append((45.0, _some_bands()))
    analyzer._reading_done = True
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.05)
        assert analyzer.last_release_debug == (45.0, 45.0)
    finally:
        task.cancel()


async def test_release_frames_debug_shows_a_real_lag_instead_of_a_baselined_zero():
    """The regression this overlay exists to catch, and used to be
    structurally incapable of showing.

    Both sides were re-based at the first *released* frame, which made
    frame one read (0.00, 0.00) by construction and everything after it
    pure relative drift — so a radio visualizer running the device's whole
    buffer ahead of the audio still displayed a delta of 0.00, the lead
    having been absorbed into the baseline before any frame came out.

    Here the cast clock is 4.7s further along than the content this run is
    releasing (exactly a relayed Sonos's own measured buffer), and that has
    to be visible."""
    analyzer = AudioAnalyzer(
        elapsed_fn=lambda: 0.0,
        source_url="",
        debug_cast_elapsed_fn=lambda: 4.7,
    )
    # What _read_pcm() records right after on_first_byte() — the cast clock
    # at this run's own zero. Radio's content_position counts from there.
    analyzer._debug_baseline = 0.0
    analyzer._pending.append((0.0, _some_bands()))
    analyzer._reading_done = True
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.05)
        assert analyzer.last_release_debug == (0.0, 4.7)
    finally:
        task.cancel()


async def test_release_frames_debug_baseline_re_bases_a_late_opened_radio_run():
    """Radio's content_position is relative to *this* analyzer's own decode
    (0 at first byte — a station has no absolute position to seek to) while
    the cast clock has been running since /play-url. Without the first-byte
    baseline a visualizer opened ten minutes into a station would report a
    -600s "delta" that means nothing at all."""
    analyzer = AudioAnalyzer(
        elapsed_fn=lambda: 0.0,
        source_url="",
        debug_cast_elapsed_fn=lambda: 600.0,
    )
    analyzer._debug_baseline = 600.0  # cast clock at this run's first byte
    analyzer._pending.append((0.0, _some_bands()))
    analyzer._reading_done = True
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.05)
        assert analyzer.last_release_debug == (0.0, 0.0)
    finally:
        task.cancel()


async def test_release_frames_last_release_lead_is_none_without_a_lead_fn():
    """The common case — a track, or radio via Chromecast/DLNA/direct-
    Sonos, none of which have a fixed/measured lead concept at all (see
    AudioAnalyzer's own docstring on debug_lead_fn)."""
    analyzer = AudioAnalyzer(
        elapsed_fn=lambda: 0.0,
        source_url="http://media/track.flac",
        debug_cast_elapsed_fn=lambda: 0.0,
    )
    analyzer._pending.append((0.0, _some_bands()))
    analyzer._reading_done = True
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.05)
        assert analyzer.last_release_lead is None
    finally:
        task.cancel()


async def test_release_frames_sets_last_release_lead_when_given_a_lead_fn():
    """core/visualizer_feed.py's _FirstByteClock.debug_lead() — the only
    clock with one, wired only for a relayed Sonos (no RadioPositionTracker
    — see AudioAnalyzer's own docstring)."""
    analyzer = AudioAnalyzer(
        elapsed_fn=lambda: 0.0,
        source_url="http://media/track.flac",
        debug_cast_elapsed_fn=lambda: 0.0,
        debug_lead_fn=lambda: (4.7, False),
    )
    analyzer._pending.append((0.0, _some_bands()))
    analyzer._reading_done = True
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.05)
        assert analyzer.last_release_lead == (4.7, False)
    finally:
        task.cancel()


async def test_release_frames_lead_updates_live_once_a_real_measurement_lands():
    # Same two-frames-queued-up-front shape as the cast-clock progression
    # test below, for the same reason (see its own comment).
    playback_elapsed = 0.0
    lead: tuple[float, bool] = (4.7, False)
    analyzer = AudioAnalyzer(
        elapsed_fn=lambda: playback_elapsed,
        source_url="http://media/track.flac",
        debug_cast_elapsed_fn=lambda: 0.0,
        debug_lead_fn=lambda: lead,
    )
    analyzer._pending.append((0.0, _some_bands()))
    analyzer._pending.append((1.0, _some_bands()))
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.05)
        assert analyzer.last_release_lead == (4.7, False)
        playback_elapsed = 1.0
        lead = (2.31, True)
        # The "not due yet" branch caps its own sleep at 0.5s (see
        # _release_frames()) before re-checking.
        await asyncio.sleep(0.55)
        assert analyzer.last_release_lead == (2.31, True)
    finally:
        task.cancel()


async def test_release_frames_debug_cast_position_advances_with_the_cast_clock():
    # Both frames queued up front (spread 5.0s, past _PREBUFFER_SECONDS)
    # rather than relying on _reading_done — that flag ends this loop the
    # instant _pending next drains, before a frame appended after the fact
    # would ever be seen. elapsed_fn tracks whatever content_position
    # should be due — this test is about debug_cast_elapsed_fn's own
    # progression, not _release_frames()'s ordinary due/late pacing
    # (covered elsewhere).
    playback_elapsed = 5.0
    cast_elapsed = 100.0
    analyzer = AudioAnalyzer(
        elapsed_fn=lambda: playback_elapsed,
        source_url="http://media/track.flac",
        debug_cast_elapsed_fn=lambda: cast_elapsed,
    )
    analyzer._debug_baseline = 100.0  # what _read_pcm() records at first byte
    analyzer._pending.append((5.0, _some_bands()))
    analyzer._pending.append((10.0, _some_bands()))
    task = asyncio.create_task(analyzer._release_frames())
    try:
        await asyncio.sleep(0.05)
        # Only the first frame is due so far. content_position raw (5.0);
        # the cast clock re-based to this run's first byte (100.0 - 100.0).
        assert analyzer.last_release_debug == (5.0, 0.0)
        playback_elapsed = 10.0
        cast_elapsed = 102.5
        # The "not due yet" branch caps its own sleep at 0.5s (see
        # _release_frames()) before re-checking — has to be given at least
        # that long to notice the new values above, not just a token delay.
        await asyncio.sleep(0.55)
        # content_position 10.0 raw; cast 102.5 - 100.0 = 2.5. The two
        # diverging by 2.5s is exactly what this overlay is for — under the
        # old both-sides-baselined scheme it read (5.0, 2.5) and the
        # absolute gap was invisible.
        assert analyzer.last_release_debug == (10.0, 2.5)
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


async def test_release_frames_yields_between_consecutive_drops():
    """Regression test, reported live 2026-09-02 as stuttering *device*
    audio: a permanently mis-calibrated elapsed_fn (the bug fixed the same
    day in core/visualizer_feed.py's _start_radio_analyzer()) makes *every*
    pending frame read as impossibly late forever, not just an ordinary
    catch-up burst — and the drop branch used to `continue` straight back
    to the top with no await at all, so as long as _pending kept refilling
    (which _read_pcm() does continuously for radio), this loop span
    synchronously popping and dropping, starving every other task sharing
    the event loop, device audio streaming included. Defense in depth
    against that class of bug recurring, not a fix for a specific one —
    see that fix's own comment."""
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 100.0, source_url="http://media/track.flac")
    for i in range(5):
        analyzer._pending.append((float(i), [1.0] * _BAND_COUNT))  # all ~100s late
    analyzer._reading_done = True
    with patch("asyncio.sleep", new=AsyncMock()) as sleep_mock:
        await asyncio.wait_for(analyzer._release_frames(), timeout=1.0)

    assert sleep_mock.await_count >= 5
    assert all(call.args[0] == 0 for call in sleep_mock.await_args_list)
    assert list(analyzer.frames._queue) == []


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


async def test_read_pcm_calls_on_first_byte_once_the_first_non_empty_chunk_lands():
    """core/visualizer_feed.py's radio fallback clock (_FirstByteClock, for
    a target with no RadioPositionTracker) is driven by this hook rather
    than by wrapping the PCM source itself — radio's own ffmpeg (spawned
    via source_url, same as a track) has no wrapper to hook into, only its
    stdout."""
    pcm = _tone_pcm(440, _FFT_SIZE)
    analyzer = _fake_analyzer_with_stdout(elapsed_fn=lambda: 0.0, stdout_chunks=[pcm, b""])
    on_first_byte = MagicMock()
    analyzer._on_first_byte = on_first_byte

    await analyzer._read_pcm()

    on_first_byte.assert_called_once()


async def test_read_pcm_does_not_call_on_first_byte_for_an_empty_read():
    analyzer = _fake_analyzer_with_stdout(elapsed_fn=lambda: 0.0, stdout_chunks=[b""])
    on_first_byte = MagicMock()
    analyzer._on_first_byte = on_first_byte

    await analyzer._read_pcm()

    on_first_byte.assert_not_called()


async def test_read_pcm_calls_on_first_byte_only_once_across_multiple_chunks():
    n_samples = _FFT_SIZE + 2 * _HOP_SIZE
    pcm = _tone_pcm(440, n_samples)
    half = len(pcm) // 2
    analyzer = _fake_analyzer_with_stdout(
        elapsed_fn=lambda: 0.0, stdout_chunks=[pcm[:half], pcm[half:], b""]
    )
    on_first_byte = MagicMock()
    analyzer._on_first_byte = on_first_byte

    await analyzer._read_pcm()

    on_first_byte.assert_called_once()


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


# ── Piped source (radio: the relay's own device-audio fan-out) ───────────────


class _FakeStdin:
    """asyncio's StreamWriter surface AudioAnalyzer._write_input() actually
    uses — enough to see what reached ffmpeg and whether EOF was sent."""

    def __init__(self) -> None:
        self.written = bytearray()
        self.closed = False

    def write(self, data: bytes) -> None:
        self.written.extend(data)

    async def drain(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True


class _FakeProc:
    def __init__(self) -> None:
        self.stdin = _FakeStdin()
        self.stdout = _EmptyStdout()
        self.killed = False

    def kill(self) -> None:
        self.killed = True


class _EmptyStdout:
    """Never yields PCM, so _read_pcm() ends immediately and these tests
    stay about the input side."""

    async def read(self, _n: int) -> bytes:
        return b""


async def test_piped_source_decodes_from_stdin_not_a_second_fetch():
    """The radio path feeds AudioAnalyzer the same bytes the device is
    being sent, from core/radio_relay.py's fan-out, instead of fetching the
    station a second time. A second fetch cannot be lined up with the
    device at all: a station greets each new client with a burst of
    already-elapsed audio to prime its buffer, seconds' worth and
    station-dependent, so "first byte" means something different on each
    connection. Reported live 2026-09-03 as the visualizer running 5-10s
    behind the speaker."""
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_queue=queue)
    with patch("core.audio_analysis.asyncio.create_subprocess_exec") as spawn:
        spawn.return_value = _FakeProc()
        await analyzer.start()
    cmd = spawn.call_args.args
    assert "pipe:0" in cmd
    assert spawn.call_args.kwargs["stdin"] is asyncio.subprocess.PIPE
    await analyzer.stop()


async def test_piped_source_forwards_the_queue_into_ffmpeg_stdin():
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    proc = _FakeProc()
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_queue=queue)
    with patch("core.audio_analysis.asyncio.create_subprocess_exec", return_value=proc):
        await analyzer.start()
    queue.put_nowait(b"station-bytes")
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert b"station-bytes" in bytes(proc.stdin.written)
    await analyzer.stop()


async def test_piped_source_closes_stdin_when_the_relay_stops():
    """A None in the queue means the relay has stopped for good — ffmpeg
    needs the EOF, or it sits waiting on a stdin nothing will ever feed."""
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    proc = _FakeProc()
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_queue=queue)
    with patch("core.audio_analysis.asyncio.create_subprocess_exec", return_value=proc):
        await analyzer.start()
    queue.put_nowait(None)
    for _ in range(4):
        await asyncio.sleep(0)
    assert proc.stdin.closed
    await analyzer.stop()


async def test_a_url_source_still_gets_no_stdin():
    """The track path is unchanged — it has a real URL to decode and
    nothing to write in."""
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_url="http://media/track.mp3")
    with patch("core.audio_analysis.asyncio.create_subprocess_exec") as spawn:
        spawn.return_value = _FakeProc()
        await analyzer.start()
    assert "http://media/track.mp3" in spawn.call_args.args
    assert spawn.call_args.kwargs["stdin"] is asyncio.subprocess.DEVNULL
    await analyzer.stop()


async def test_a_live_source_rejoins_instead_of_working_through_a_backlog():
    """A live station cannot be caught up with by decoding — nothing
    arrives faster than real time. Working through the backlog anyway runs
    analyze_pcm() at full speed on audio already too late to release,
    starving the loop device audio is paced on: heard live 2026-09-03 as
    speaker dropouts alongside a permanently frozen visualizer."""
    clock = 0.0
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    analyzer = AudioAnalyzer(elapsed_fn=lambda: clock, source_queue=queue)
    analyzer._pending.extend([(1.0, [0.0]), (2.0, [0.0])])
    analyzer._pcm_position = 5.0
    clock = 60.0  # a stall put the clock 55s ahead of what has been decoded

    analyzer._resync_if_behind()

    assert analyzer._pcm_position == 60.0
    assert not analyzer._pending


async def test_a_live_source_tolerates_ordinary_jitter():
    """Only a real stall resyncs — a poll-driven clock steps in ~0.5s
    increments, and treating that as a stall would throw frames away
    constantly."""
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 1.0, source_queue=queue)
    analyzer._pending.append((0.4, [0.0]))
    analyzer._pcm_position = 0.5  # half a second behind

    analyzer._resync_if_behind()

    assert analyzer._pcm_position == 0.5
    assert len(analyzer._pending) == 1


async def test_a_file_source_never_skips_its_backlog():
    """A track is a file: decode outruns real time, so a backlog really is
    temporary and skipping it would drop audio that is about to be needed."""
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 60.0, source_url="http://media/track.mp3")
    analyzer._pending.append((1.0, [0.0]))
    analyzer._pcm_position = 5.0

    analyzer._resync_if_behind()

    assert analyzer._pcm_position == 5.0
    assert len(analyzer._pending) == 1


async def test_a_live_hold_off_is_capped_so_a_stopped_clock_cannot_wedge_the_run():
    """The excess is measured against a clock this analyzer doesn't own. If
    that clock stops, the excess is arbitrarily large — and sleeping it out
    in one go means not reading stdout for that long either, so ffmpeg
    blocks on its write and _write_input() blocks behind it. The run stays
    wedged well past the moment the clock recovers."""
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_queue=queue)
    analyzer._pcm_position = 600.0  # clock stopped ten minutes ago

    slept: list[float] = []

    async def _record(delay: float) -> None:
        slept.append(delay)

    with patch("core.audio_analysis.asyncio.sleep", _record):
        await analyzer._wait_out_lookahead(600.0 - 0.0)

    assert slept == [audio_analysis_mod._STALL_RECHECK_SECONDS]


async def test_a_file_hold_off_still_sleeps_off_the_whole_lead():
    """A track's clock is the session's own calibrated one and its decode
    really does run far ahead — one long sleep is right there."""
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 10.0, source_url="http://media/track.mp3")
    slept: list[float] = []

    async def _record(delay: float) -> None:
        slept.append(delay)

    with patch("core.audio_analysis.asyncio.sleep", _record):
        await analyzer._wait_out_lookahead(30.0)

    assert slept == [30.0 - audio_analysis_mod._MAX_LOOKAHEAD_SECONDS]


async def test_a_stalled_clock_is_reported_once_not_every_check(caplog):
    """The point is diagnosing a clock that isn't advancing; repeating it
    every second would bury the rest of the log for as long as it lasts."""
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    analyzer = AudioAnalyzer(elapsed_fn=lambda: 0.0, source_queue=queue)
    analyzer._pcm_position = 60.0
    clock = iter([100.0, 100.0 + 9, 100.0 + 18, 100.0 + 27])

    async def _noop(_delay: float) -> None:
        pass

    with (
        caplog.at_level(logging.WARNING, logger="connect.audio"),
        patch("core.audio_analysis.time.monotonic", side_effect=lambda: next(clock)),
        patch("core.audio_analysis.asyncio.sleep", _noop),
    ):
        for _ in range(4):
            await analyzer._wait_out_lookahead(60.0)

    stalls = [r for r in caplog.records if "decode held for" in r.message]
    assert len(stalls) == 1
