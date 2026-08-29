"""Tests for core/streamer.py — source-codec detection and the resulting
ffmpeg command selection (stream-copy vs. lossless re-encode vs. the mp3
192k fallback). See resolve_output_format()'s docstring for the tiers."""

import asyncio
import logging
from unittest.mock import AsyncMock, patch

import pytest

from core.streamer import (
    FALLBACK_FORMAT,
    LOOKAHEAD_SECONDS,
    REASON_CODEC_NOT_CASTABLE,
    REASON_CODEC_UNKNOWN,
    REASON_DEVICE_LIMIT,
    REASON_LOSSLESS_CONTAINER,
    REASON_PROBE_FAILED,
    REASON_QUALITY_LIMIT,
    REASON_REPLAY_GAIN,
    OutputFormat,
    SourceInfo,
    _probe_source,
    lossy_encode_args,
    resolve_output_format,
    stream_tracks,
    transcoded_byte_length,
)


def _info(
    codec: str,
    sample_rate: int | None = None,
    bit_depth: int | None = None,
    bitrate_kbps: int | None = None,
    duration: float | None = None,
) -> SourceInfo:
    return SourceInfo(
        codec=codec,
        sample_rate=sample_rate,
        bit_depth=bit_depth,
        bitrate_kbps=bitrate_kbps,
        duration=duration,
    )


def _fake_probe_proc(stderr: bytes, returncode: int = 1):
    """A fake ffmpeg -i subprocess: `ffmpeg -i <url>` with no output target
    always exits non-zero after printing stream info to stderr — that's the
    expected shape _probe_source() parses, not a failure."""
    proc = AsyncMock()
    proc.communicate = AsyncMock(return_value=(b"", stderr))
    proc.returncode = returncode
    return proc


# ── _probe_source ─────────────────────────────────────────────────────────────


def test_probe_source_parses_flac_stream_line():
    stderr = b"Stream #0:0: Audio: flac, 96000 Hz, stereo, s32 (24 bit)"
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=_fake_probe_proc(stderr))):
        result = asyncio.run(_probe_source("http://nav/stream"))
    assert result == _info("flac", sample_rate=96000, bit_depth=24)


def test_probe_source_parses_mp3_stream_line():
    stderr = (
        b"Input #0, mp3, from 'http://nav/stream':\n"
        b"  Duration: 00:04:32.10, start: 0.000000, bitrate: 320 kb/s\n"
        b"    Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s"
    )
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=_fake_probe_proc(stderr))):
        result = asyncio.run(_probe_source("http://nav/stream"))
    # mp3's own line has no parenthesized "(N bit)" — bit_depth is simply
    # unknown for it, not guessed at. It does carry its own bitrate though,
    # and the container line above it carries the real length.
    assert result == _info(
        "mp3", sample_rate=44100, bit_depth=None, bitrate_kbps=320, duration=272.10
    )


def test_probe_source_reads_pcm_bit_depth_without_parens():
    stderr = b"Stream #0:0: Audio: pcm_s24le, 48000 Hz, stereo, s24 (24 bit)"
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=_fake_probe_proc(stderr))):
        result = asyncio.run(_probe_source("http://nav/stream"))
    assert result == _info("pcm_s24le", sample_rate=48000, bit_depth=24)


def test_probe_source_does_not_read_past_the_audio_streams_own_line():
    # A track with embedded cover art gets a second, video/attached-pic
    # Stream line from ffmpeg — its own (unrelated) numbers must never leak
    # into the audio line's sample_rate/bit_depth.
    stderr = (
        b"Stream #0:0: Audio: flac, 44100 Hz, stereo, s16\n"
        b"Stream #0:1: Video: mjpeg, none, 96000x1 (96 bit), 90k tbr"
    )
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=_fake_probe_proc(stderr))):
        result = asyncio.run(_probe_source("http://nav/stream"))
    assert result == _info("flac", sample_rate=44100, bit_depth=None)


def test_probe_source_reads_bitrate_from_the_streams_own_line_not_the_container_summary():
    # Regression guard for the exact mistake docs/playback-bugs/
    # fixed-pacing-used-container-bitrate.md documents: the container
    # summary line's bitrate includes embedded cover art and is *not* the
    # audio's own bitrate. Deliberately different numbers on each line here
    # (397 vs. 320, the real figures from that incident) so reading the
    # wrong one would be caught immediately rather than coincidentally
    # matching.
    stderr = (
        b"Input #0, mp3, from 'http://nav/stream':\n"
        b"  Duration: 00:06:51.00, start: 0.000000, bitrate: 397 kb/s\n"
        b"    Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s"
    )
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=_fake_probe_proc(stderr))):
        result = asyncio.run(_probe_source("http://nav/stream"))
    assert result.bitrate_kbps == 320


def test_probe_source_bitrate_is_none_for_a_lossless_codec():
    # FLAC/ALAC/PCM never report a "N kb/s" figure on their own Audio
    # line — nothing here should guess one.
    stderr = b"Stream #0:0: Audio: flac, 96000 Hz, stereo, s32 (24 bit)"
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=_fake_probe_proc(stderr))):
        result = asyncio.run(_probe_source("http://nav/stream"))
    assert result.bitrate_kbps is None


def test_probe_source_returns_none_when_no_audio_stream_line():
    stderr = b"Some unrelated ffmpeg banner output, no Stream line at all"
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=_fake_probe_proc(stderr))):
        result = asyncio.run(_probe_source("http://nav/stream"))
    assert result is None


def test_probe_source_returns_none_on_subprocess_failure():
    with patch("asyncio.create_subprocess_exec", AsyncMock(side_effect=OSError("boom"))):
        result = asyncio.run(_probe_source("http://nav/stream"))
    assert result is None


def test_probe_source_returns_none_on_timeout():
    proc = AsyncMock()
    proc.communicate = AsyncMock(side_effect=asyncio.TimeoutError)
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
        result = asyncio.run(_probe_source("http://nav/stream"))
    assert result is None


# ── probed duration ──────────────────────────────────────────────────────────
# The music server only ever reports whole seconds (media/base.py's
# Track.duration is an int), so the end of a track is scheduled off this
# instead — see routes/stream.py's _playback_duration().


def test_probe_source_reads_the_real_duration_to_hundredths():
    stderr = (
        b"Input #0, flac, from 'http://nav/stream':\n"
        b"  Duration: 00:03:03.61, start: 0.000000, bitrate: 1005 kb/s\n"
        b"    Stream #0:0: Audio: flac, 44100 Hz, stereo, s16 (16 bit)"
    )
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=_fake_probe_proc(stderr))):
        result = asyncio.run(_probe_source("http://nav/stream"))
    # 3:03.61 — the .61 is exactly what a whole-second metadata duration
    # throws away, and what gets cut off the end of the track with it.
    assert result.duration == pytest.approx(183.61)


def test_probe_source_reads_an_hours_long_duration():
    stderr = (
        b"  Duration: 01:02:03.50, start: 0.000000, bitrate: 320 kb/s\n"
        b"    Stream #0:0: Audio: mp3, 44100 Hz, stereo"
    )
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=_fake_probe_proc(stderr))):
        result = asyncio.run(_probe_source("http://nav/stream"))
    assert result.duration == pytest.approx(3723.5)


def test_probe_source_reports_no_duration_for_an_endless_stream():
    # A live stream's Duration reads "N/A" — must stay None rather than
    # being parsed as some number.
    stderr = (
        b"  Duration: N/A, start: 0.000000, bitrate: 128 kb/s\n"
        b"    Stream #0:0: Audio: mp3, 44100 Hz, stereo"
    )
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=_fake_probe_proc(stderr))):
        result = asyncio.run(_probe_source("http://nav/stream"))
    assert result.duration is None


def test_resolve_output_format_carries_the_probed_duration_on_every_tier():
    """Every tier that got a probe result reports it, the fallback ones
    included: how long the audio is doesn't depend on which encoder ends up
    handling it, and routes/stream.py schedules the end of the track off
    this regardless of tier."""
    for codec, gain in [("flac", 1.0), ("alac", 1.0), ("flac", 0.8), ("wmav2", 1.0)]:
        with patch(
            "core.streamer._probe_source",
            AsyncMock(return_value=_info(codec, duration=183.61)),
        ):
            fmt = asyncio.run(resolve_output_format("http://nav/stream", gain=gain))
        assert fmt.source_duration == pytest.approx(183.61), f"{codec} gain={gain}"


def test_a_format_that_never_probed_reports_no_duration():
    with patch("core.streamer._probe_source", AsyncMock(return_value=None)):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.source_duration is None
    assert FALLBACK_FORMAT.source_duration is None


# ── resolve_output_format tiers ──────────────────────────────────────────────


@pytest.mark.parametrize(
    "codec,expected_muxer,expected_content_type",
    [
        ("flac", "flac", "audio/flac"),
        ("mp3", "mp3", "audio/mpeg"),
        ("aac", "adts", "audio/aac"),
        ("vorbis", "ogg", "audio/ogg"),
    ],
)
def test_resolve_output_format_copy_tier(codec, expected_muxer, expected_content_type):
    with patch("core.streamer._probe_source", AsyncMock(return_value=_info(codec))):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.ffmpeg_args == ["-acodec", "copy", "-f", expected_muxer]
    assert fmt.content_type == expected_content_type
    assert "-ar" not in fmt.ffmpeg_args


@pytest.mark.parametrize("codec", ["flac", "mp3", "aac", "vorbis"])
def test_resolve_output_format_replay_gain_rules_out_the_copy_tier(codec):
    """Regression test: `ffmpeg -af volume=X -acodec copy` fails outright
    (confirmed live 2026-08-22 — "Filtering and streamcopy cannot be used
    together") — a ReplayGain-enabled track that would otherwise qualify
    for stream-copy must fall back to a real re-encode instead of silently
    never producing any audio at all."""
    with patch("core.streamer._probe_source", AsyncMock(return_value=_info(codec))):
        fmt = asyncio.run(resolve_output_format("http://nav/stream", gain=0.8))
    assert fmt.ffmpeg_args == FALLBACK_FORMAT.ffmpeg_args
    assert fmt.transcode_reason == "replay_gain"
    assert "copy" not in fmt.ffmpeg_args


def test_resolve_output_format_replay_gain_does_not_affect_the_lossless_reencode_tier():
    """This tier already decodes+re-encodes to FLAC regardless of gain — a
    volume filter fits into that same pipeline for free, no fallback
    needed."""
    with patch("core.streamer._probe_source", AsyncMock(return_value=_info("alac"))):
        fmt = asyncio.run(resolve_output_format("http://nav/stream", gain=0.8))
    assert fmt.ffmpeg_args == ["-acodec", "flac", "-f", "flac"]


def test_resolve_output_format_unity_gain_still_uses_the_copy_tier():
    """The default (no ReplayGain, or a mode/track where the multiplier is
    exactly 1.0) must be unaffected — this isn't a blanket regression on
    the copy tier's whole reason to exist."""
    with patch("core.streamer._probe_source", AsyncMock(return_value=_info("mp3"))):
        fmt = asyncio.run(resolve_output_format("http://nav/stream", gain=1.0))
    assert fmt.ffmpeg_args == ["-acodec", "copy", "-f", "mp3"]


@pytest.mark.parametrize("codec", ["alac", "pcm_s16le", "pcm_s24le", "pcm_s16be", "ape"])
def test_resolve_output_format_lossless_reencode_tier(codec):
    with patch("core.streamer._probe_source", AsyncMock(return_value=_info(codec))):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.ffmpeg_args == ["-acodec", "flac", "-f", "flac"]
    assert fmt.content_type == "audio/flac"
    assert "-ar" not in fmt.ffmpeg_args


def test_resolve_output_format_falls_back_when_detection_fails():
    with patch("core.streamer._probe_source", AsyncMock(return_value=None)):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.ffmpeg_args == FALLBACK_FORMAT.ffmpeg_args
    assert fmt.transcode_reason == "probe_failed"
    assert fmt.content_type == "audio/mpeg"
    assert "-ar" in fmt.ffmpeg_args


def test_resolve_output_format_falls_back_for_unrecognized_codec():
    with patch("core.streamer._probe_source", AsyncMock(return_value=_info("wmav2"))):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.ffmpeg_args == FALLBACK_FORMAT.ffmpeg_args
    assert fmt.transcode_reason == "codec_unknown"


def test_resolve_output_format_falls_back_for_opus():
    """Regression test: confirmed live (2026-08-19) that a real Sonos speaker
    accepts an opus-in-ogg stream-copy URI but produces no audio for it —
    Sonos' own published format list has no Opus entry (only Ogg Vorbis).
    Opus must stay out of the copy tier and fall through to the mp3
    fallback instead of risking silent playback on real hardware."""
    with patch("core.streamer._probe_source", AsyncMock(return_value=_info("opus", 48000))):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.ffmpeg_args == FALLBACK_FORMAT.ffmpeg_args
    # Not "unknown": opus is recognized and decodable, it's kept out of the
    # copy tier on purpose (Sonos plays it silently).
    assert fmt.transcode_reason == "codec_not_castable"


# ── resolve_output_format device sample-rate/bit-depth limits ───────────────
# Regression tests for a real bug (root-caused 2026-08-22, fixed 2026-08-24 —
# see docs/playback-bugs/copy-tier-device-limits.md): a 24-bit/96kHz FLAC
# copied straight to a Sonos reported
# ERROR_UNSUPPORTED_FREQ over UPnP eventing and stopped 1.1s in.


def test_resolve_output_format_copies_a_source_within_the_devices_limit():
    # No behavior change for the common case: nothing here should start
    # resampling sources that were already fine.
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("flac", sample_rate=44100, bit_depth=16)),
    ):
        fmt = asyncio.run(
            resolve_output_format("http://nav/stream", max_sample_rate=48000, max_bit_depth=24)
        )
    assert fmt.ffmpeg_args == ["-acodec", "copy", "-f", "flac"]


def test_resolve_output_format_resamples_a_copy_eligible_codec_over_the_rate_limit():
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("flac", sample_rate=96000, bit_depth=24)),
    ):
        fmt = asyncio.run(
            resolve_output_format("http://nav/stream", max_sample_rate=48000, max_bit_depth=24)
        )
    assert "copy" not in fmt.ffmpeg_args
    assert fmt.ffmpeg_args == ["-acodec", "flac", "-f", "flac", "-ar", "48000"]
    assert fmt.content_type == "audio/flac"
    # Bit depth (24) is within the limit here — only the rate needs fixing.
    assert "-sample_fmt" not in fmt.ffmpeg_args


def test_resolve_output_format_resamples_over_the_bit_depth_limit_too():
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("flac", sample_rate=44100, bit_depth=24)),
    ):
        fmt = asyncio.run(
            resolve_output_format("http://nav/stream", max_sample_rate=48000, max_bit_depth=16)
        )
    assert fmt.ffmpeg_args == ["-acodec", "flac", "-f", "flac", "-sample_fmt", "s16"]


def test_resolve_output_format_never_upsamples_a_source_below_the_limit():
    # A device limit is a ceiling, not a target — a 44.1kHz source must stay
    # exactly that even when a much higher limit is declared.
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("flac", sample_rate=44100, bit_depth=16)),
    ):
        fmt = asyncio.run(
            resolve_output_format("http://nav/stream", max_sample_rate=192000, max_bit_depth=32)
        )
    assert fmt.ffmpeg_args == ["-acodec", "copy", "-f", "flac"]


def test_resolve_output_format_leaves_a_source_alone_when_rate_could_not_be_detected():
    # No sample_rate reading (see _probe_source's own "not guessed" comment)
    # means there is nothing to compare against a limit — must not be
    # treated as "0 Hz, therefore over the limit" or any other guess.
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("mp3", sample_rate=None, bit_depth=None)),
    ):
        fmt = asyncio.run(
            resolve_output_format("http://nav/stream", max_sample_rate=44100, max_bit_depth=16)
        )
    assert fmt.ffmpeg_args == ["-acodec", "copy", "-f", "mp3"]


def test_resolve_output_format_no_declared_limit_leaves_a_high_res_source_untouched():
    # max_sample_rate/max_bit_depth default to None — every caller from
    # before this mechanism existed (a delivery whose class never declared
    # a limit, or a purely local/non-cast dispatch) must behave exactly as
    # it always did.
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("flac", sample_rate=192000, bit_depth=32)),
    ):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.ffmpeg_args == ["-acodec", "copy", "-f", "flac"]


def test_resolve_output_format_resamples_the_lossless_reencode_tier_too():
    # ALAC/PCM/APE already go through a real re-encode (never stream-copy),
    # so this is purely about whether the resample args get added to that
    # existing pipeline, not about which tier gets picked.
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("alac", sample_rate=96000, bit_depth=24)),
    ):
        fmt = asyncio.run(
            resolve_output_format("http://nav/stream", max_sample_rate=48000, max_bit_depth=24)
        )
    assert fmt.ffmpeg_args == ["-acodec", "flac", "-f", "flac", "-ar", "48000"]


def test_resolve_output_format_resample_tier_ignores_replay_gain():
    # Every resample path already decodes+re-encodes (same as the plain
    # lossless-reencode tier) — stream_tracks() fits a volume filter into
    # that pipeline for free, so gain != 1.0 must not additionally fall
    # back to mp3 the way it does for an actual stream-copy.
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("flac", sample_rate=96000, bit_depth=24)),
    ):
        fmt = asyncio.run(
            resolve_output_format(
                "http://nav/stream", gain=0.8, max_sample_rate=48000, max_bit_depth=24
            )
        )
    assert fmt.ffmpeg_args == ["-acodec", "flac", "-f", "flac", "-ar", "48000"]


# ── resolve_output_format source info (for the stream-info overlay) ─────────
# core/session.py's build_status_dict() surfaces these on OutputFormat as
# stream_info.source_codec/source_sample_rate/source_bit_depth.


def test_resolve_output_format_copy_tier_carries_source_info():
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("mp3", sample_rate=44100, bit_depth=None, bitrate_kbps=320)),
    ):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.source_codec == "mp3"
    assert fmt.source_sample_rate == 44100
    assert fmt.source_bitrate_kbps == 320


def test_resolve_output_format_resampled_tier_carries_the_sources_own_numbers():
    # The *source's* numbers, not the resampled target's — the whole point
    # is showing "96kHz, resampled to 48kHz", not hiding the resample ever
    # happened.
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("flac", sample_rate=96000, bit_depth=24)),
    ):
        fmt = asyncio.run(
            resolve_output_format("http://nav/stream", max_sample_rate=48000, max_bit_depth=24)
        )
    assert fmt.source_codec == "flac"
    assert fmt.source_sample_rate == 96000
    assert fmt.source_bit_depth == 24


def test_resolve_output_format_lossless_reencode_tier_carries_source_info():
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("alac", sample_rate=44100, bit_depth=16)),
    ):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.source_codec == "alac"
    assert fmt.source_sample_rate == 44100
    assert fmt.source_bit_depth == 16


def test_resolve_output_format_fallback_has_no_source_info():
    # FALLBACK_FORMAT is the shared default instance — nothing was probed
    # (or the probe result was discarded), so there's nothing accurate to
    # report rather than a guess.
    with patch("core.streamer._probe_source", AsyncMock(return_value=None)):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.source_codec is None
    assert fmt.source_sample_rate is None
    assert fmt.source_bit_depth is None
    assert fmt.source_bitrate_kbps is None


def test_resolve_output_format_replay_gain_fallback_has_no_source_info():
    # This path probes successfully (codec would have qualified for copy)
    # but discards the result in favor of FALLBACK_FORMAT because of gain —
    # see resolve_output_format()'s own docstring. Must not report the
    # probed source's numbers next to a format that isn't actually using them.
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("mp3", sample_rate=44100, bit_depth=None)),
    ):
        fmt = asyncio.run(resolve_output_format("http://nav/stream", gain=0.8))
    assert fmt.ffmpeg_args == FALLBACK_FORMAT.ffmpeg_args
    assert fmt.source_codec is None


# ── transcode reason / target reporting ──────────────────────────────────────
# What the frontend's stream-info section shows next to "Transcoding" — the
# tier alone never said *why* a track isn't being copied, or what it's being
# turned into (see components/connect/StreamInfoSection.vue).


def test_copy_tier_reports_no_reason_at_all():
    # Nothing is being transcoded, so there is nothing to explain.
    with patch("core.streamer._probe_source", AsyncMock(return_value=_info("flac"))):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.transcode_reason is None
    assert fmt.target_sample_rate is None
    assert fmt.target_bit_depth is None


def test_device_limit_reports_the_rate_it_is_actually_resampled_to():
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("flac", sample_rate=96000, bit_depth=24)),
    ):
        fmt = asyncio.run(
            resolve_output_format("http://nav/stream", max_sample_rate=48000, max_bit_depth=24)
        )
    assert fmt.transcode_reason == "device_limit"
    assert fmt.target_sample_rate == 48000
    # Untouched, so deliberately not restated as a "target" of its own.
    assert fmt.target_bit_depth is None


def test_device_limit_reports_the_bit_depth_it_is_actually_reduced_to():
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("flac", sample_rate=44100, bit_depth=24)),
    ):
        fmt = asyncio.run(
            resolve_output_format("http://nav/stream", max_sample_rate=48000, max_bit_depth=16)
        )
    assert fmt.transcode_reason == "device_limit"
    assert fmt.target_bit_depth == 16
    assert fmt.target_sample_rate is None


@pytest.mark.parametrize("codec", ["alac", "pcm_s16le", "ape"])
def test_lossless_reencode_reports_the_container_as_the_reason(codec):
    with patch("core.streamer._probe_source", AsyncMock(return_value=_info(codec))):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.transcode_reason == "lossless_container"
    assert fmt.target_sample_rate is None


def test_a_resampled_lossless_source_reports_the_device_limit_instead():
    # Both are true at once — the device limit is the more specific (and
    # more actionable) of the two, so it's the one reported.
    with patch(
        "core.streamer._probe_source",
        AsyncMock(return_value=_info("alac", sample_rate=96000, bit_depth=24)),
    ):
        fmt = asyncio.run(
            resolve_output_format("http://nav/stream", max_sample_rate=44100, max_bit_depth=16)
        )
    assert fmt.transcode_reason == "device_limit"
    assert fmt.target_sample_rate == 44100
    assert fmt.target_bit_depth == 16


def test_every_reason_the_frontend_knows_about_is_one_this_module_can_produce():
    """The frontend translates these keys one by one (an unknown one shows
    no reason at all rather than leaking the key — see
    StreamInfoSection.vue's reasonText), so the two lists have to stay in
    step. This is the canonical set."""
    assert {
        REASON_PROBE_FAILED,
        REASON_DEVICE_LIMIT,
        REASON_QUALITY_LIMIT,
        REASON_REPLAY_GAIN,
        REASON_LOSSLESS_CONTAINER,
        REASON_CODEC_NOT_CASTABLE,
        REASON_CODEC_UNKNOWN,
    } == {
        "probe_failed",
        "device_limit",
        "quality_limit",
        "replay_gain",
        "lossless_container",
        "codec_not_castable",
        "codec_unknown",
    }


# ── The listener's quality ceiling ───────────────────────────────────────────
# resolve_output_format()'s max_lossy_format/max_lossy_bitrate_kbps — the
# frontend's cast quality setting. It caps the tiers above rather than
# replacing them, so most of what matters here is what it leaves alone.


def _resolve(info, **kwargs):
    with patch("core.streamer._probe_source", AsyncMock(return_value=info)):
        return asyncio.run(resolve_output_format("http://nav/stream", **kwargs))


def test_quality_ceiling_re_encodes_a_lossless_source():
    """A FLAC is above every lossy ceiling there is, whatever number it
    names — that's the whole reason someone sets one."""
    fmt = _resolve(
        _info("flac", sample_rate=44100, bit_depth=16, duration=180.0),
        max_lossy_format="mp3",
        max_lossy_bitrate_kbps=192,
    )

    assert fmt.ffmpeg_args == [
        "-acodec",
        "libmp3lame",
        "-b:a",
        "192k",
        "-ar",
        "44100",
        "-f",
        "mp3",
    ]
    assert fmt.content_type == "audio/mpeg"
    assert fmt.transcode_reason == REASON_QUALITY_LIMIT
    # The source's own numbers still travel to the stream-info overlay.
    assert fmt.source_codec == "flac"
    assert fmt.source_duration == 180.0


def test_quality_ceiling_leaves_a_lossy_source_under_it_copied():
    """The point of a ceiling is to stop streams *bigger* than it. A
    192kbps mp3 under a 320kbps ceiling already qualifies, and re-encoding
    it would throw away quality for no reduction at all."""
    fmt = _resolve(
        _info("mp3", sample_rate=44100, bitrate_kbps=192),
        max_lossy_format="mp3",
        max_lossy_bitrate_kbps=320,
    )

    assert fmt.ffmpeg_args == ["-acodec", "copy", "-f", "mp3"]
    assert fmt.transcode_reason is None


def test_quality_ceiling_re_encodes_a_lossy_source_above_it():
    fmt = _resolve(
        _info("mp3", sample_rate=44100, bitrate_kbps=320),
        max_lossy_format="mp3",
        max_lossy_bitrate_kbps=128,
    )

    assert "-b:a" in fmt.ffmpeg_args
    assert fmt.ffmpeg_args[fmt.ffmpeg_args.index("-b:a") + 1] == "128k"
    assert fmt.transcode_reason == REASON_QUALITY_LIMIT


def test_quality_ceiling_leaves_a_lossy_source_of_unknown_bitrate_alone():
    """ffmpeg reports no bitrate for some sources (see SourceInfo). Acting
    on a number we don't have would re-encode an already-small file for
    nothing — the same rule the rest of this module follows."""
    fmt = _resolve(
        _info("mp3", sample_rate=44100, bitrate_kbps=None),
        max_lossy_format="mp3",
        max_lossy_bitrate_kbps=96,
    )

    assert fmt.ffmpeg_args == ["-acodec", "copy", "-f", "mp3"]


@pytest.mark.parametrize(
    "kwargs",
    [
        {},
        {"max_lossy_format": "mp3"},
        {"max_lossy_bitrate_kbps": 192},
    ],
)
def test_no_ceiling_means_exactly_the_old_behaviour(kwargs):
    """Both halves are needed for either to count — a half-set ceiling is a
    caller bug, and guessing the missing half would silently downgrade
    somebody's audio."""
    fmt = _resolve(_info("flac", sample_rate=44100, bit_depth=16), **kwargs)

    assert fmt.ffmpeg_args == ["-acodec", "copy", "-f", "flac"]


def test_unknown_ceiling_format_is_ignored_rather_than_obeyed(caplog):
    """A format this build has no encoder for can't be honoured. Falling
    back to the untouched source is the safe reading; guessing a different
    encoder is not."""
    with caplog.at_level(logging.WARNING, logger="connect.streamer"):
        fmt = _resolve(
            _info("flac", sample_rate=44100, bit_depth=16),
            max_lossy_format="wma",
            max_lossy_bitrate_kbps=192,
        )

    assert fmt.ffmpeg_args == ["-acodec", "copy", "-f", "flac"]
    assert any("wma" in r.message for r in caplog.records)


def test_device_limit_still_caps_the_rate_the_ceiling_encodes_at():
    """The device's own ceiling is what it can decode at all — a rate it
    rejects produces silence, so it wins over the listener's preference
    rather than being averaged with it."""
    fmt = _resolve(
        _info("flac", sample_rate=96000, bit_depth=24),
        max_sample_rate=44100,
        max_bit_depth=16,
        max_lossy_format="aac",
        max_lossy_bitrate_kbps=256,
    )

    assert fmt.ffmpeg_args[fmt.ffmpeg_args.index("-ar") + 1] == "44100"
    assert fmt.target_sample_rate == 44100
    # -sample_fmt belongs to the FLAC tiers; libmp3lame/aac reject it and
    # pick their own sample format anyway.
    assert "-sample_fmt" not in fmt.ffmpeg_args


def test_ceiling_keeps_a_48khz_source_at_48khz():
    """Resampling that isn't required is quality thrown away for nothing —
    same rule _resample_plan() already follows for the FLAC tiers."""
    fmt = _resolve(
        _info("flac", sample_rate=48000, bit_depth=24),
        max_lossy_format="mp3",
        max_lossy_bitrate_kbps=320,
    )

    assert fmt.ffmpeg_args[fmt.ffmpeg_args.index("-ar") + 1] == "48000"


def test_the_ceiling_reports_the_bitrate_it_encoded_at():
    """The stream-info panel used to hardcode "192 kb/s" against the mp3
    content type, which was right while the fallback was the only way to
    reach mp3. A ceiling can now land on that same content type at 320 or
    96, so the number has to travel with the format."""
    fmt = _resolve(
        _info("flac", sample_rate=44100, bit_depth=16),
        max_lossy_format="mp3",
        max_lossy_bitrate_kbps=320,
    )

    assert fmt.target_bitrate_kbps == 320


def test_the_fallback_tier_reports_its_own_fixed_bitrate():
    fmt = _resolve(_info("opus", sample_rate=48000))

    assert fmt.content_type == "audio/mpeg"
    assert fmt.target_bitrate_kbps == 192


def test_a_copied_track_reports_no_target_bitrate():
    """Nothing was chosen — the output is the source's own bytes, and the
    source line already says what those are."""
    fmt = _resolve(_info("flac", sample_rate=44100, bit_depth=16))

    assert fmt.target_bitrate_kbps is None


# ── lossy_encode_args() / transcoded_byte_length() ───────────────────────────
# Shared with routes/local_stream.py, where the byte arithmetic below is what
# makes seeking work in a browser.


@pytest.mark.parametrize(
    "fmt,codec,muxer,content_type",
    [
        ("mp3", "libmp3lame", "mp3", "audio/mpeg"),
        ("aac", "aac", "adts", "audio/aac"),
        ("opus", "libopus", "ogg", "audio/ogg"),
    ],
)
def test_lossy_encode_args_per_format(fmt, codec, muxer, content_type):
    args, ct = lossy_encode_args(fmt, 192, source_rate=44100)

    assert args[:4] == ["-acodec", codec, "-b:a", "192k"]
    assert args[-2:] == ["-f", muxer]
    assert ct == content_type


def test_opus_is_forced_to_constant_bitrate():
    """Opus is variable-rate by default, and a variable-rate stream has no
    byte-to-time mapping — which is exactly what routes/local_stream.py
    divides by to answer a Range request."""
    args, _ = lossy_encode_args("opus", 128, source_rate=44100)

    assert args[args.index("-vbr") + 1] == "off"


def test_opus_always_encodes_at_48khz():
    """ffmpeg's opus encoder has no other rate. Picking the nearest lower
    allowed value instead would land a 44.1kHz source on 24kHz."""
    args, _ = lossy_encode_args("opus", 128, source_rate=44100)

    assert args[args.index("-ar") + 1] == "48000"


def test_lossy_encode_falls_back_to_44100_when_the_source_rate_is_unknown():
    args, _ = lossy_encode_args("mp3", 192, source_rate=None)

    assert args[args.index("-ar") + 1] == "44100"


def test_lossy_encode_resamples_a_rate_the_encoder_cannot_take():
    """MP3 has no 96kHz mode at all — handing one to libmp3lame fails
    outright rather than being quietly accepted."""
    args, _ = lossy_encode_args("mp3", 320, source_rate=96000)

    assert args[args.index("-ar") + 1] == "48000"


def test_transcoded_byte_length_matches_the_bitrate_it_was_encoded_at():
    # 192 kbps = 24000 bytes/s; 180s of it is 4,320,000 bytes.
    assert transcoded_byte_length(192, 180.0) == 4_320_000


def test_transcoded_byte_length_rounds_up():
    """Never short: a length below what ffmpeg actually produces truncates
    the end of the track in the browser."""
    assert transcoded_byte_length(192, 180.5) == 4_332_000


# ── stream_tracks() command building ─────────────────────────────────────────


class _FakeProc:
    """Fake ffmpeg subprocess for stream_tracks() — yields no audio bytes,
    just lets the command that would have been run be inspected."""

    def __init__(self):
        self.returncode = 0
        self.stdout = AsyncMock()
        self.stdout.read = AsyncMock(side_effect=[b"", b""])
        self.stderr = AsyncMock()
        self.stderr.read = AsyncMock(return_value=b"")

    async def wait(self):
        return None


async def _drain(url, output_format):
    captured_cmd = {}

    async def _fake_exec(*cmd, **kwargs):
        captured_cmd["cmd"] = cmd
        return _FakeProc()

    with patch("asyncio.create_subprocess_exec", _fake_exec):
        async for _ in stream_tracks([url], output_format=output_format):
            pass
    return captured_cmd["cmd"]


def test_stream_tracks_copy_tier_omits_forced_resample():
    fmt = OutputFormat(ffmpeg_args=["-acodec", "copy", "-f", "flac"], content_type="audio/flac")
    cmd = asyncio.run(_drain("http://nav/stream", fmt))
    assert "-ar" not in cmd
    assert "-acodec" in cmd and cmd[cmd.index("-acodec") + 1] == "copy"
    assert "-f" in cmd and cmd[cmd.index("-f") + 1] == "flac"


def test_stream_tracks_lossless_reencode_tier_omits_forced_resample():
    fmt = OutputFormat(ffmpeg_args=["-acodec", "flac", "-f", "flac"], content_type="audio/flac")
    cmd = asyncio.run(_drain("http://nav/stream", fmt))
    assert "-ar" not in cmd


def test_stream_tracks_fallback_keeps_forced_resample():
    cmd = asyncio.run(_drain("http://nav/stream", FALLBACK_FORMAT))
    assert "-ar" in cmd and cmd[cmd.index("-ar") + 1] == "44100"
    assert "-acodec" in cmd and cmd[cmd.index("-acodec") + 1] == "libmp3lame"


def test_stream_tracks_defaults_to_fallback_when_no_format_given():
    cmd = asyncio.run(_drain("http://nav/stream", None))
    assert "-ar" in cmd and cmd[cmd.index("-ar") + 1] == "44100"


async def _drain_kwargs(url, **kwargs):
    captured_cmd = {}

    async def _fake_exec(*cmd, **_kwargs):
        captured_cmd["cmd"] = cmd
        return _FakeProc()

    with patch("asyncio.create_subprocess_exec", _fake_exec):
        async for _ in stream_tracks([url], **kwargs):
            pass
    return captured_cmd["cmd"]


def test_stream_tracks_empty_url_list_yields_nothing():
    async def _collect():
        return [chunk async for chunk in stream_tracks([])]

    assert asyncio.run(_collect()) == []


def test_stream_tracks_calls_on_track_start_for_each_track_with_its_index():
    calls = []

    async def _fake_exec(*cmd, **kwargs):
        return _FakeProc()

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(
                ["http://a", "http://b"], on_track_start=lambda i: calls.append(i)
            ):
                pass

    asyncio.run(_run())
    assert calls == [0, 1]


def test_stream_tracks_seeks_the_first_track_when_start_offset_is_set():
    cmd = asyncio.run(_drain_kwargs("http://nav/stream", start_offset=12.5))
    assert cmd[cmd.index("-ss") + 1] == "12.500"
    # Before -i, for fast input-side seeking — see the function's own comment.
    assert cmd.index("-ss") < cmd.index("-i")


def test_stream_tracks_ignores_a_negligible_start_offset():
    cmd = asyncio.run(_drain_kwargs("http://nav/stream", start_offset=0.2))
    assert "-ss" not in cmd


def test_stream_tracks_applies_a_gain_filter_when_not_unity():
    cmd = asyncio.run(_drain_kwargs("http://nav/stream", gain=0.5))
    assert cmd[cmd.index("-af") + 1] == "volume=0.5"
    assert cmd.index("-af") < cmd.index("-vn")


def test_stream_tracks_omits_the_gain_filter_at_unity():
    cmd = asyncio.run(_drain_kwargs("http://nav/stream", gain=1.0))
    assert "-af" not in cmd


# ── stream_tracks() process I/O and failure handling ─────────────────────────


class _ConfigurableFakeProc:
    """Like _FakeProc above, but stdout.read()'s sequence, stderr, returncode
    and kill() are all configurable — for exercising the actual byte-yielding
    and failure-handling paths below, not just the command that got built."""

    def __init__(
        self, stdout_chunks=(b"",), stderr: bytes = b"", returncode: int = 0, kill_error=None
    ):
        self.returncode = returncode
        self.stdout = AsyncMock()
        self.stdout.read = AsyncMock(side_effect=list(stdout_chunks))
        self.stderr = AsyncMock()
        self.stderr.read = AsyncMock(return_value=stderr)
        self.killed = False
        self._kill_error = kill_error

    def kill(self) -> None:  # real Process.kill() is synchronous, not awaited
        self.killed = True
        if self._kill_error:
            raise self._kill_error

    async def wait(self):
        return None


def test_stream_tracks_yields_the_process_stdout_chunks():
    proc = _ConfigurableFakeProc(stdout_chunks=[b"abc", b"def", b""])

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _collect():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            return [chunk async for chunk in stream_tracks(["http://nav/stream"])]

    assert asyncio.run(_collect()) == [b"abc", b"def"]


def test_stream_tracks_logs_a_warning_on_a_nonzero_ffmpeg_exit(caplog):
    proc = _ConfigurableFakeProc(stderr=b"unsupported codec", returncode=1)

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with caplog.at_level(logging.WARNING, logger="connect.streamer"):
        asyncio.run(_run())

    assert "exit 1" in caplog.text
    assert "unsupported codec" in caplog.text


def test_stream_tracks_logs_stray_stderr_output_at_debug_even_on_success(caplog):
    proc = _ConfigurableFakeProc(stderr=b"a warning ffmpeg printed anyway", returncode=0)

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with caplog.at_level(logging.DEBUG, logger="connect.streamer"):
        asyncio.run(_run())

    assert "a warning ffmpeg printed anyway" in caplog.text


def test_stream_tracks_propagates_and_logs_when_ffmpeg_binary_is_missing(caplog):
    """Propagates (not a silent early return) so stream_with_completion()
    doesn't mistake a missing ffmpeg binary for a normal end-of-stream and
    fire a track-end broadcast — see the function's own comment."""

    async def _fake_exec(*cmd, **kwargs):
        raise FileNotFoundError()

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with (
        caplog.at_level(logging.ERROR, logger="connect.streamer"),
        pytest.raises(FileNotFoundError),
    ):
        asyncio.run(_run())

    assert "ffmpeg not found" in caplog.text


def test_stream_tracks_kills_the_process_and_reraises_on_cancellation():
    proc = _ConfigurableFakeProc(stdout_chunks=[b"chunk", asyncio.CancelledError()])

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(_run())

    assert proc.killed is True


def test_stream_tracks_swallows_a_kill_error_during_cancellation():
    proc = _ConfigurableFakeProc(
        stdout_chunks=[asyncio.CancelledError()], kill_error=RuntimeError("already dead")
    )

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with pytest.raises(asyncio.CancelledError):  # not the kill() error instead
        asyncio.run(_run())


def test_stream_tracks_kills_the_process_and_reraises_on_an_unexpected_error():
    """Propagates rather than silently ending the generator — a genuine
    ffmpeg failure (crash, decode error) is not a natural end either, same
    reasoning as the missing-binary case above."""
    proc = _ConfigurableFakeProc(stdout_chunks=[RuntimeError("pipe broke")])

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with pytest.raises(RuntimeError):
        asyncio.run(_run())

    assert proc.killed is True


@pytest.mark.parametrize(
    "args,content_type",
    [
        (["-acodec", "copy", "-f", "mp3"], "audio/mpeg"),
        (["-acodec", "flac", "-f", "flac"], "audio/flac"),
        (list(FALLBACK_FORMAT.ffmpeg_args), FALLBACK_FORMAT.content_type),
    ],
)
def test_stream_tracks_paces_every_tier_via_ffmpeg_readrate(args, content_type):
    """Regression test (2026-08-22). Pacing used to be a hand-rolled
    throttle in stream_tracks() that estimated produced-audio-seconds from
    a bitrate the probe read off ffmpeg's "Duration: ..., bitrate: N kb/s"
    line. That is the *container* bitrate — embedded cover art included —
    while the bytes being counted are audio-only (-vn strips the attached
    picture), so for a track with a large cover the throttle over-delivered
    by exactly that ratio. Measured live: a ~4MB PNG cover (container
    397 kb/s vs. 320 kb/s of audio) made a 411s track finish in 316s and
    left the device's connection idle for 95s — the condition pacing
    existed to prevent in the first place.

    ffmpeg pacing itself against real input timestamps has no bitrate to
    get wrong, so the assertion is simply that every tier's command
    carries it — including the lossless-reencode tier, which under the old
    scheme opted out of pacing entirely (bitrate_bps=None).
    """
    captured: list[str] = []
    proc = _ConfigurableFakeProc(stdout_chunks=[b"x" * 1024, b""])

    async def _fake_exec(*cmd, **kwargs):
        captured.extend(cmd)
        return proc

    async def _run():
        fmt = OutputFormat(ffmpeg_args=args, content_type=content_type)
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"], output_format=fmt):
                pass

    asyncio.run(_run())

    assert captured[captured.index("-readrate") + 1] == "1"
    burst = captured.index("-readrate_initial_burst")
    assert captured[burst + 1] == f"{LOOKAHEAD_SECONDS:.0f}"
    # Without a catch-up rate, "1" is a ceiling with no floor: a lead lost
    # to one stall never comes back for the rest of the track, and the
    # device ends up playing at the live edge. See _READRATE_ARGS.
    assert float(captured[captured.index("-readrate_catchup") + 1]) > 1.0
    # Input options, so they must sit before -i or ffmpeg applies them to
    # the output, where they mean something else entirely.
    assert burst < captured.index("-i")
    assert captured.index("-readrate_catchup") < captured.index("-i")


def test_stream_tracks_keeps_readrate_ahead_of_a_resume_seek():
    """-ss is inserted immediately before -i on a resumed track. It must
    land *after* the readrate options, not between them and their values —
    both are input options and the order of the pair matters."""
    captured = []
    proc = _ConfigurableFakeProc(stdout_chunks=[b"x" * 1024, b""])

    async def _fake_exec(*cmd, **kwargs):
        captured.extend(cmd)
        return proc

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"], start_offset=92.075):
                pass

    asyncio.run(_run())

    assert captured[captured.index("-readrate") + 1] == "1"
    assert captured[captured.index("-readrate_initial_burst") + 1] == "15"
    assert captured.index("-readrate_initial_burst") < captured.index("-ss")
    assert captured.index("-ss") < captured.index("-i")


def test_stream_tracks_swallows_a_kill_error_after_an_unexpected_error():
    proc = _ConfigurableFakeProc(
        stdout_chunks=[RuntimeError("pipe broke")], kill_error=RuntimeError("already dead")
    )

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with pytest.raises(RuntimeError, match="pipe broke"):  # not the kill() error instead
        asyncio.run(_run())
