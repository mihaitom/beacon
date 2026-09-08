"""core/streamer.py — FFmpeg Audio Stream Engine"""

import asyncio
import logging
import math
import re
import time
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass, field

from .ffmpeg import FFMPEG_BIN

logger = logging.getLogger("connect.streamer")

# How far ahead of real playback time a stream is allowed to run before
# ffmpeg throttles itself back to real time. Long enough to smooth over an
# ordinary network/disk hiccup fetching the next stretch of the source
# without an audible stall; short enough that a device connection dropping
# mid-track only ever has to recover this many seconds of already-sent-but-
# unplayed audio, not the rest of a multi-hour file.
LOOKAHEAD_SECONDS = 15.0

# -readrate 1 tells ffmpeg to read its *input* at 1x real time, judged by
# the input's own timestamps; -readrate_initial_burst lets it run flat out
# for the first LOOKAHEAD_SECONDS to fill the device's buffer before that
# throttle engages. Both are input options, so they sit before -i.
#
# This replaced a hand-rolled throttle in stream_tracks() that estimated
# produced-audio-seconds as bytes*8/bitrate, with `bitrate` read off
# ffmpeg's "Duration: ..., bitrate: N kb/s" summary line. That line is the
# *container* bitrate, which includes any embedded cover art, while the
# bytes actually being counted are audio-only (-vn strips the attached
# picture). For a track with a large embedded cover the two diverge badly
# and the throttle silently over-delivers by that ratio. Measured live on
# beacon-dev 2026-08-22 against OVERWERK — Toccata (a ~4MB PNG cover:
# container 397 kb/s vs. 320 kb/s of actual audio): the real lead grew
# ~0.24s per second instead of holding at 15s, so ffmpeg finished a 411s
# track after 316s and left the device's connection sitting completely
# idle for the remaining 95s — the exact condition the pacing was added to
# eliminate. Confirmed in production, not just in a harness: the device
# really does swallow the whole overshoot, TCP backpressure does not
# absorb it ("FFmpeg done early — waiting 95.1s", routes/stream.py).
#
# Letting ffmpeg pace itself against real timestamps removes the estimate
# entirely, so there is no bitrate to get wrong. It also covers the tiers
# the old throttle could not: FLAC's "Stream #0:0: Audio: flac, 44100 Hz,
# stereo, s16" line carries no bitrate at all, and the lossless-reencode
# tier opted out of pacing altogether by setting bitrate_bps=None.
_READRATE_ARGS = [
    "-readrate",
    "1",
    "-readrate_initial_burst",
    f"{LOOKAHEAD_SECONDS:.0f}",
    # Without this, "1" is a ceiling with no floor: ffmpeg reads at exactly
    # real time and therefore never regains a lead it has lost. Anything
    # that stalls the pipeline once — a slow stretch fetching from the
    # media server, or this process's own event loop blocking (see
    # core/loop_health.py) — permanently shortens the device's buffer for
    # the rest of that track, and a few such events in a row leave it
    # playing at the live edge with nothing in hand. Observed on beacon-dev
    # 2026-08-22: a 2.53s loop stall early in an 80-minute mix, then a
    # device drop four minutes later with the lead down from 15s to
    # roughly nothing.
    #
    # The hand-rolled throttle this replaced did catch up, incidentally
    # rather than by design: it slept only while already more than
    # LOOKAHEAD_SECONDS ahead, so falling behind simply meant it stopped
    # sleeping and ran flat out until the lead was restored. Losing that
    # was a regression in the switch to -readrate; 2x is the explicit
    # version of the same behaviour, fast enough to refill a 15s buffer in
    # 15s without dumping the whole remaining file at the device.
    "-readrate_catchup",
    "2",
]

# What ffmpeg does when the connection to the *media server* drops
# mid-track — a different question from what the listener's own connection
# does, and one nothing here used to answer: without these, a single dropped
# TCP connection to Navidrome/Jellyfin/Plex ends the encode outright, which
# reaches a cast device as a track that stopped and the local player as a
# stream that simply finished (see the frontend's endedEarly(), which then
# has to reconnect and re-encode from that second). Reconnecting inside
# ffmpeg costs none of that: it resumes the same source at the byte it left
# off, and the output pipe never notices.
#
# Only for an http(s) source, and that is not caution but a hard
# requirement: these are private options of ffmpeg's http protocol, and
# ffmpeg refuses to *start* when they are passed alongside any other kind of
# input — "Option reconnect not found.", exit 8, measured against ffmpeg
# 9.0.1 with a plain file path. Every source that reaches ffmpeg today is an
# http(s) URL (a media server's stream URL, or a station's), so the check
# guards nothing that currently happens; it is here because the failure it
# guards against is "no audio at all" rather than "no reconnect", which is
# too steep a price for a local path finding its way in later.
#
# Deliberately without -reconnect_streamed, which is the one that looks like
# it belongs here and does not: it covers sources that *cannot* be resumed
# at an offset, and it "resumes" them by reconnecting without a Range header
# — i.e. by replaying the source from the top into the middle of an encode
# that was already minutes in. A source that can't be resumed cleanly is
# better off failing, where both callers already have a recovery path.
#
# -reconnect_delay_max 5 rather than ffmpeg's own default of 120: the
# backoff doubles and gives up once the next step would exceed this, so 5
# means roughly seven seconds of trying. Past that, the caller's own
# recovery is the better answer — the frontend's ladder is already retrying
# by then (MAX_RECONNECT_ATTEMPTS in services/audioEngine.ts), and a cast
# device's is too.
_HTTP_RECONNECT_ARGS = [
    "-reconnect",
    "1",
    # The connect *attempt* itself, not just a mid-transfer drop. That is
    # the moment this matters most for the local player: a track start is
    # the one point where the browser has no buffer in hand yet, so a
    # source connection that fails there is audible immediately, while one
    # that fails mid-track is hidden behind minutes of already-fetched
    # audio.
    "-reconnect_on_network_error",
    "1",
    "-reconnect_delay_max",
    "5",
]


def http_reconnect_args(url: str) -> list[str]:
    """_HTTP_RECONNECT_ARGS for an http(s) `url`, nothing for anything else
    — see that constant for why the distinction is load-bearing."""
    return list(_HTTP_RECONNECT_ARGS) if url.lower().startswith(("http://", "https://")) else []


_FFMPEG_BASE_CMD = [
    FFMPEG_BIN,
    "-hide_banner",
    "-loglevel",
    "warning",  # warning so codec/format issues surface in logs
    *_READRATE_ARGS,
    "-i",
    "{url}",
    "-vn",
]

# Codecs ffmpeg can copy straight through to a compatible output container
# without re-encoding, for source codecs these devices broadly support —
# whatever bitrate/quality the source already has is exactly what gets
# streamed (a 320kbps MP3 stays 320kbps; a FLAC stays exactly that FLAC).
# Requires the matching muxer to be built into ffmpeg — see the Dockerfile's
# ffmpeg-builder stage for the custom minimal build used in the Docker image.
#
# Opus is in here but on a stricter rule than the rest — see
# _COPY_NEEDS_DECLARED_SUPPORT.
_COPY_MUXER_FOR_CODEC = {
    "flac": "flac",
    "mp3": "mp3",
    "aac": "adts",
    "vorbis": "ogg",
    "opus": "ogg",
}

# Codecs that may only be copied to a target that has *said* it plays them.
#
# For everything else, a target nobody knows anything about is not judged
# (see _may_copy()) — the four above are what every delivery here declares,
# and a device that refuses one of them says so and gets the mp3 fallback.
# Opus is different because the failure is silent: a real Sonos accepts an
# opus-in-ogg URI and then produces no audio at all (confirmed live
# 2026-08-19; Sonos' own format list covers Ogg **Vorbis**, not Opus). There
# is nothing to catch afterwards, so "nothing known about the target" has to
# mean no.
#
# Only Chromecast's Default Media Receiver declares Opus today
# (delivery/chromecast.py's PLAYABLE_CODECS), and it gets an Opus source
# untouched. That is the point of the entry: re-encoding a 128kbps Opus file
# to 192kbps MP3 produces a bigger stream that sounds worse, which is the
# exact trade the quality ceiling exists to prevent.
_COPY_NEEDS_DECLARED_SUPPORT = frozenset({"opus"})

_CONTENT_TYPE_FOR_MUXER = {
    "flac": "audio/flac",
    "mp3": "audio/mpeg",
    "adts": "audio/aac",
    "ogg": "audio/ogg",
}

# The extension each of those puts on the end of the URL a device is
# handed: plenty of DLNA renderers pick their decoder from the URL rather
# than the Content-Type header, and refuse one without an extension. Only
# ever a hint — routes/stream.py serves the session either way.
_EXTENSION_FOR_CONTENT_TYPE = {
    "audio/flac": "flac",
    "audio/mpeg": "mp3",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
}

STREAM_URL_EXTENSIONS = frozenset(_EXTENSION_FOR_CONTENT_TYPE.values())


def stream_extension(content_type: str | None) -> str | None:
    """The extension a stream URL for `content_type` ends in, or None for a
    type we don't serve. Tolerates a parameterised type ("audio/mpeg; ...")."""
    base_type = (content_type or "").split(";")[0].strip().lower()
    return _EXTENSION_FOR_CONTENT_TYPE.get(base_type)


def strip_stream_extension(session_id: str) -> str:
    """The inverse, for the routes. Only our own extensions — a session id
    that legitimately contains a dot keeps it."""
    base, dot, extension = session_id.rpartition(".")
    if dot and extension.lower() in STREAM_URL_EXTENSIONS:
        return base
    return session_id


# Lossless source codecs that aren't good copy-tier targets for these devices
# (wrong container, or not a format cast devices are expected to accept) —
# re-encoded losslessly to FLAC instead, so there's still no quality loss
# even though the bytes on the wire change.
#
# This has to hold every lossless codec the bundled ffmpeg can decode, not
# just the common ones: what is missing here doesn't fail, it silently drops
# to the mp3-192k fallback at the bottom of resolve_output_format(), so a
# lossless source quietly casts as lossy and the only visible sign is the
# stream-info panel saying "codec_unknown". The PCM entries are every depth
# and byte order a WAV or AIFF can carry, matching the decoder list in
# build/ffmpeg/required-components — a 32-bit WAV is not more exotic than a
# 24-bit one.
#
# DSD is in here too, but only because _dsd_sample_rate_cap() below gives it
# a rate anything can play first — see that constant.
_LOSSLESS_REENCODE_CODECS = {
    "alac",
    "ape",
    "wavpack",
    "tta",
    "shorten",
    "wmalossless",
    "pcm_s8",
    "pcm_u8",
    "pcm_s16le",
    "pcm_s16be",
    "pcm_s24le",
    "pcm_s24be",
    "pcm_s32le",
    "pcm_s32be",
    "pcm_f32le",
    "pcm_f32be",
    "pcm_f64le",
    "pcm_f64be",
    "dsd_lsbf",
    "dsd_msbf",
    "dsd_lsbf_planar",
    "dsd_msbf_planar",
}

# DSD (.dsf/.dff) is one bit at 2.8MHz and upwards, and ffmpeg hands it on as
# PCM at an eighth of that: 352800 Hz for DSD64, 705600 for DSD128 (measured
# against a real DSF file). Nothing here plays a FLAC at those rates — cast
# targets declare 48 or 96kHz, and a browser's own decoder stops well short
# too — so a DSD source that kept its decoded rate would be a lossless stream
# nobody can hear.
#
# 88200 Hz because that is what a DSD player picks for the same reason: an
# exact quarter of DSD64's decoded rate, four times the audible band, and low
# enough to leave behind the ultrasonic noise DSD's own one-bit shaping puts
# up there — that noise is the format's, not the music's. The result is still
# lossless in every sense a listener can check, and it is a FLAC every target
# accepts instead of an MP3 re-encode.
#
# A device's own limit still wins where it is lower; this only decides what
# happens when nothing else has capped the rate.
_DSD_CODECS = frozenset({"dsd_lsbf", "dsd_msbf", "dsd_lsbf_planar", "dsd_msbf_planar"})
_DSD_PCM_SAMPLE_RATE = 88200


def dsd_sample_rate_cap(codec: str | None, max_sample_rate: int | None) -> int | None:
    """`max_sample_rate` with DSD's own PCM ceiling folded in, unchanged for
    every other codec — see _DSD_PCM_SAMPLE_RATE."""
    if codec not in _DSD_CODECS:
        return max_sample_rate
    if max_sample_rate is None:
        return _DSD_PCM_SAMPLE_RATE
    return min(max_sample_rate, _DSD_PCM_SAMPLE_RATE)


def dsd_resample_args(info: "SourceInfo | None") -> list[str]:
    """The `-ar` arguments a DSD source needs on a path that has no device to
    be limited by — routes/local_stream.py's lossless tier, which otherwise
    hands the browser the source rate exactly as it came. [] for everything
    else, including a DSD source already at or below the cap."""
    if info is None or info.codec not in _DSD_CODECS:
        return []
    if info.sample_rate is not None and info.sample_rate <= _DSD_PCM_SAMPLE_RATE:
        return []
    return ["-ar", str(_DSD_PCM_SAMPLE_RATE)]


_FALLBACK_BITRATE_KBPS = 192
_FALLBACK_ARGS = [
    "-acodec",
    "libmp3lame",
    "-ab",
    f"{_FALLBACK_BITRATE_KBPS}k",
    "-ar",
    "44100",
    "-f",
    "mp3",
]
_FALLBACK_CONTENT_TYPE = "audio/mpeg"

# Source codecs that carry the full signal. A lossy ceiling always applies
# to these, whatever bitrate number it names: there is no such thing as a
# lossless source that already fits under "at most 192 kbps".
#
# Deliberately derived from _LOSSLESS_REENCODE_CODECS rather than listed
# again — that set is the same question asked for a different purpose (which
# lossless codecs need a container change to be castable), and two hand-kept
# lists of lossless codecs would drift.
_LOSSLESS_CODECS = _LOSSLESS_REENCODE_CODECS | {"flac"}

# The lossy encoders a quality ceiling can name, with the muxer each one's
# output goes into. Not the same question as _COPY_MUXER_FOR_CODEC above,
# which is about codecs we pass through untouched: opus is missing there
# because a Sonos won't play it, and present here because a browser will —
# whether a target can play a format is the caller's business (see
# resolve_output_format()'s max_lossy_format), not this table's.
_LOSSY_ENCODERS = {
    "mp3": ("libmp3lame", "mp3"),
    "aac": ("aac", "adts"),
    "opus": ("libopus", "ogg"),
}

# Sample rates each lossy encoder actually accepts. A source outside them
# has to be resampled — MP3 has no 96kHz mode at all, and ffmpeg's opus
# encoder only ever works at 48kHz. Picked as "the highest allowed rate at
# or below what we want, else the lowest allowed one", which lands opus on
# 48000 from anything and leaves an ordinary 44.1kHz source alone.
_LOSSY_ENCODER_RATES = {
    "mp3": (32000, 44100, 48000),
    "aac": (32000, 44100, 48000),
    "opus": (48000,),
}


def _lossy_sample_rate(fmt: str, source_rate: int | None, max_sample_rate: int | None) -> int:
    """Output sample rate for a lossy re-encode of a source at
    `source_rate`, respecting a device's own `max_sample_rate` ceiling.

    A source whose rate couldn't be detected gets 44100 — the same value
    the mp3 fallback tier has always forced, and the one rate every
    encoder here accepts."""
    allowed = _LOSSY_ENCODER_RATES[fmt]
    if source_rate is None:
        rate = 44100
    elif max_sample_rate is not None:
        rate = min(source_rate, max_sample_rate)
    else:
        rate = source_rate
    if rate in allowed:
        return rate
    return max((r for r in allowed if r <= rate), default=min(allowed))


def lossy_encode_args(
    fmt: str,
    bitrate_kbps: int,
    source_rate: int | None = None,
    max_sample_rate: int | None = None,
) -> tuple[list[str], str]:
    """ffmpeg output args for a lossy encode to `fmt`, plus the content type
    the result carries.

    Opus is encoded in constrained VBR, and which of the three modes to use
    is a decided question rather than a taste: it was `-vbr off` (CBR) for
    as long as routes/local_stream.py turned a byte offset back into a
    timestamp by dividing by exactly this bitrate, which needs a stream
    whose bytes really do run at that rate. That division is gone — a
    caller asks for a position in seconds (`start`) and nothing maps bytes
    onto time any more — so the mode was measured instead (ffmpeg 9.0.1,
    120s at 44.1kHz, `-b:a 96k`, packet sizes off ffprobe):

        signal                 -vbr off   constrained   -vbr on
        pink noise, wide        96.6k      97.0k         85.8k
        pink noise, mono        96.6k      97.0k         64.0k
        a few sine tones        96.6k      97.1k        109.7k
        worst second, tones     97.9k     100.2k        112.6k
        worst second @64k        65.3k      67.0k         84.8k

    Plain `-vbr on` is out on the numbers: this bitrate is a ceiling
    somebody set because their connection has a limit, and a mode that
    answers 96k with 110k — 64k with 85k — is not honouring it. Between
    the other two the data is the same and the difference is where it
    goes: CBR pads every packet to the same size whatever is in it
    (measured on a file that is quiet for a minute and then loud: every
    packet exactly 240 bytes, in both halves), while constrained VBR holds
    the identical average and the same worst second while letting a hard
    passage have 415 bytes and an easy one 196. Those are bits that were
    being spent on padding and are now spent on the music.

    Shared with resolve_output_format()'s quality-ceiling tier so a track
    capped for a cast device and the same track transcoded for local
    playback are encoded by identical commands."""
    codec, muxer = _LOSSY_ENCODERS[fmt]
    rate = _lossy_sample_rate(fmt, source_rate, max_sample_rate)
    args = ["-acodec", codec, "-b:a", f"{bitrate_kbps}k", "-ar", str(rate)]
    if fmt == "opus":
        args += ["-vbr", "constrained"]
    args += ["-f", muxer]
    return args, _CONTENT_TYPE_FOR_MUXER[muxer]


def lossless_encode_args(resample_args: list[str] | None = None) -> tuple[list[str], str]:
    """ffmpeg output args for a lossless re-encode, plus the content type.

    Where a source has to change container without being allowed to lose
    anything: an ALAC or APE track for a cast device (resolve_output_format()
    below), and the same track for a browser that cannot decode it while the
    listener has asked for Original (routes/local_stream.py). Both mean the
    same thing — keep every bit, change only the wrapper — so both ask here
    rather than each spelling out an encoder.

    `resample_args` for the case where the container is not the only problem:
    a source past a device's sample rate or bit depth is re-encoded *and*
    brought down to it, and those arguments come from the device's own
    limits. Nothing for the local path, which has no device to be limited
    by."""
    return [
        "-acodec",
        "flac",
        # The FLAC encoder takes its block size from the first frame it is
        # handed, and refuses to start on one shorter than FLAC allows:
        # "invalid block size: 8", and not a byte is produced. That is
        # reachable from an ordinary request — an ALAC source with any `-ss`
        # at all decodes to a short first frame (measured against ffmpeg
        # 9.0.1; the same source without `-ss` encodes fine, and moving the
        # seek to the output side does not help), which is a cast resuming
        # mid-track and every seek the local player makes. Naming the block
        # size outright takes the decision away from whatever frame happens
        # to arrive first.
        #
        # 4096 because it is what the encoder picks for itself at these
        # sample rates. Verified lossless with it: the PCM decoded back out
        # of the FLAC is byte-identical to the PCM decoded from the ALAC.
        "-frame_size",
        "4096",
        "-f",
        "flac",
        *(resample_args or []),
    ], "audio/flac"


# Which lossy encoder to fall back to when a device cannot decode the one
# the listener asked for, best first. Efficiency order, not preference
# order: opus is never *chosen* here (a listener who picks it and casts to
# a Chromecast keeps it, and one who picks mp3 is not "upgraded" to it
# behind their back) — this only decides where to land when the picked
# format is off the table.
_LOSSY_FALLBACK_ORDER = ("aac", "mp3")


def _codec_for_ceiling(fmt: str, device_codecs: frozenset[str] | None) -> str:
    """The encoder to actually use for a `fmt` quality ceiling on a target
    that plays `device_codecs`.

    `fmt` itself wherever the device can decode it, and where nothing is
    known about the device at all (`None` — no delivery active, i.e. the
    caller has no target to be wrong about).

    Otherwise the best format the device does play, which is what makes
    Opus offerable as a cast setting at all: a Chromecast gets Opus, and
    the same setting reaches a Sonos as AAC and an AirPlay device as MP3
    instead of as silence. The bitrate is deliberately *not* raised to
    compensate — it is a ceiling somebody set because their connection or
    their patience has a limit, and quietly sending more than they asked
    for is the one thing the setting exists to prevent. It costs some
    quality on a device that has to fall back, which is visible in the
    stream-info panel rather than hidden.

    Falls back to mp3 if a device somehow plays none of the three, which
    cannot happen today (every delivery declares mp3) and is still not
    worth an exception: mp3 is the universal fallback this whole module
    already ends on."""
    if device_codecs is None or fmt in device_codecs:
        return fmt
    for candidate in _LOSSY_FALLBACK_ORDER:
        if candidate in device_codecs:
            logger.info(
                f"[ffmpeg] quality ceiling asks for {fmt}, which this target does not "
                f"play — encoding {candidate} instead"
            )
            return candidate
    logger.warning(f"[ffmpeg] target plays none of {sorted(_LOSSY_ENCODERS)} — falling back to mp3")
    return "mp3"


def transcoded_byte_length(bitrate_kbps: int, duration: float) -> int:
    """How many bytes a `duration`-second constant-bitrate encode produces.

    An estimate, and unavoidably so — the real file also carries container
    framing, and the last frame is padded. It lands within a fraction of a
    percent for the bitrates offered here, which is what a browser needs to
    seek: it maps a scrub position onto a byte offset through this number,
    and the server maps it back the same way (see lossy_encode_args()).
    Both directions use the same arithmetic, so the two agree exactly even
    where they are both slightly off the real file."""
    return math.ceil(bitrate_kbps * 1000 / 8 * duration)


_PROBE_TIMEOUT = 10.0
_AUDIO_STREAM_RE = re.compile(rb"Stream #\d+:\d+.*?Audio:\s*([a-zA-Z0-9_]+)")
# Both searched only within the matched Audio line itself (see _probe_source),
# never the whole stderr blob — a source with embedded cover art gets a
# second, video/attached-pic Stream line from ffmpeg that has no "Hz" of its
# own to false-match, but there's no reason to rely on that alone.
_SAMPLE_RATE_RE = re.compile(rb",\s*(\d+)\s*Hz")
# ffmpeg reports the *real* bit depth this way only for formats where the
# sample format alone doesn't already say it (FLAC/ALAC's internal 32-bit
# buffer isn't the source's own depth) — e.g. "s32 (24 bit)". Formats that
# don't carry this (raw PCM's "s16"/"s24" already *is* the real depth) are
# simply reported as None here; nothing in this module currently needs a
# depth cap for those (_LOSSLESS_REENCODE_CODECS' own real-world sources are
# overwhelmingly ALAC/FLAC-adjacent, where this pattern applies).
_BIT_DEPTH_RE = re.compile(rb"\((\d+)\s*bit\)")
# The Audio stream's *own* line carries its bitrate for lossy codecs (e.g.
# "mp3, 44100 Hz, stereo, fltp, 320 kb/s") — deliberately not the same
# thing the pacing bug this backend already fixed once read (the container
# summary line's "Duration: ..., bitrate: N kb/s", which includes embedded
# cover art and is *not* the audio's own bitrate; see
# docs/investigations/fixed-pacing-used-container-bitrate.md). Bound to the
# same per-line search as sample rate/bit depth above, for the same reason.
# Absent for lossless codecs (FLAC/ALAC/PCM never report one here) — never
# guessed at, same convention as sample_rate/bit_depth being None.
_BITRATE_RE = re.compile(rb",\s*(\d+)\s*kb/s")
# The container summary line's own "Duration: 00:03:03.61" — hundredths of a
# second, i.e. the real audio length, unlike the whole-second `duration` a
# music server's metadata carries (media/base.py's Track.duration is an int,
# and Jellyfin's/Plex's adapters truncate rather than round). That difference
# is audible: auto-advance scheduled off a truncated duration cuts the last
# fraction of a second off a track that ends abruptly. Matched against the
# whole probe output rather than the Audio stream's own line, unlike every
# regex above — this one deliberately *is* the container line those go out
# of their way not to read.
_DURATION_RE = re.compile(rb"Duration:\s*(\d+):(\d\d):(\d\d)\.(\d+)")


@dataclass
class OutputFormat:
    """What ffmpeg should do with a source, and what the result actually is —
    the single source of truth both `/stream`'s Content-Type header and each
    delivery's device-facing metadata (DIDL protocolInfo, Cast content_type)
    read from, so they can never disagree with what stream_tracks() sends.

    `source_codec`/`source_sample_rate`/`source_bit_depth`/`source_bitrate_kbps`
    are the probed source's own numbers (see SourceInfo) — carried along
    purely for core/session.py's build_status_dict() to surface in the
    frontend's stream-info overlay ("FLAC 96kHz/24bit, resampled to 48kHz
    for this device"). None on the fallback/default instance and on the
    ReplayGain-forced-fallback path in resolve_output_format(): both discard
    whatever the probe found rather than acting on it, so there is nothing
    accurate to report.

    `source_duration` is the probed length in seconds, to hundredths — see
    _DURATION_RE on why the music server's own whole-second duration isn't
    good enough for scheduling the end of a track. Unlike the other source_*
    fields it survives onto the fallback tiers wherever a probe did happen:
    how long the audio is doesn't depend on which tier ends up encoding it.

    `target_sample_rate`/`target_bit_depth` are only set where this format
    actually forces the output away from the source's own numbers (the
    resampled tiers) — None everywhere else, since "the target equals the
    source" is already visible from the source fields and repeating it
    would just read as a second, redundant claim. `target_bitrate_kbps`
    follows the same rule for a lossy re-encode's chosen bitrate.

    `transcode_reason` is a stable key, not prose: the frontend's
    stream-info section turns it into a translated sentence (see
    components/connect/StreamInfoSection.vue), so the wording can change
    per language without this file knowing anything about it. None on the
    copy tier, which isn't transcoding at all."""

    ffmpeg_args: list[str] = field(default_factory=lambda: list(_FALLBACK_ARGS))
    content_type: str = _FALLBACK_CONTENT_TYPE
    label: str = "mp3-192k (fallback)"
    source_codec: str | None = None
    source_sample_rate: int | None = None
    source_bit_depth: int | None = None
    source_bitrate_kbps: int | None = None
    source_duration: float | None = None
    target_sample_rate: int | None = None
    target_bit_depth: int | None = None
    # The output's own bitrate, set only on the tiers that pick one. The
    # frontend used to hardcode "192 kb/s" against the mp3 content type,
    # which was accurate while the fallback was the only way to reach mp3;
    # a quality ceiling can now land on that same content type at 320 or
    # 96, so the number has to travel with it rather than be assumed.
    # None on every tier whose bitrate is simply the source's own.
    target_bitrate_kbps: int | None = None
    transcode_reason: str | None = None


FALLBACK_FORMAT = OutputFormat()

# Reasons a track can end up transcoded, as they reach the frontend. Kept
# together here so the set is readable in one place rather than scattered
# across resolve_output_format()'s branches — see OutputFormat's own
# comment on why these are keys and not sentences.
REASON_PROBE_FAILED = "probe_failed"  # ffmpeg couldn't tell us what the source is
REASON_DEVICE_LIMIT = "device_limit"  # source exceeds the target's sample rate/bit depth
REASON_QUALITY_LIMIT = "quality_limit"  # source exceeds the quality ceiling the user set
REASON_REPLAY_GAIN = "replay_gain"  # copying rules out the volume filter ReplayGain needs
REASON_LOSSLESS_CONTAINER = "lossless_container"  # lossless, but not in a castable container
REASON_CODEC_NOT_CASTABLE = "codec_not_castable"  # decodable, but this target cannot play it
REASON_CODEC_UNKNOWN = "codec_unknown"  # nothing recognized it
# Radio only: the relay's own repertoire is MP3 and AAC (see
# core/radio_relay.py), so a station arriving as anything else is re-encoded
# on the way through no matter what any device could have played.
# Deliberately not REASON_CODEC_NOT_CASTABLE, which says the source codec is
# the problem — a Chromecast takes Opus quite happily, and telling the
# listener otherwise describes a limit that is Beacon's, not their device's.
#
# It was REASON_RELAY_MP3_ONLY while MP3 really was the whole repertoire.
# The listener never read the key itself (the sentence under it says
# "converted for the device", which stayed true throughout), but a name that
# has outlived its reason is one more thing to have to know.
REASON_RELAY_FORMAT_LIMIT = "relay_format_limit"
# Radio only, and not a property of the audio at all: the device refused
# the station's own stream (see routes/upnp.py and /play-url's own retry),
# so Beacon re-encodes it to plain MP3 and serves that instead. Beacon
# hands a station's bytes straight to the device by default and only ends
# up here once that has demonstrably failed.
REASON_DEVICE_REJECTED_STREAM = "device_rejected_stream"


def _fallback(reason: str, duration: float | None = None) -> OutputFormat:
    """The mp3-192k fallback, carrying why this particular track landed on
    it. A fresh instance rather than FALLBACK_FORMAT itself, which stays
    the shared reason-less default (core/state.py's initial value,
    /debug's reset) — the command and content type are identical either
    way.

    `duration` is passed on wherever a probe actually ran: this tier
    discards the source's *format* on purpose (it isn't encoding to it),
    but the audio's length is the same either way, and routes/stream.py
    schedules the end of the track off it."""
    return OutputFormat(
        transcode_reason=reason,
        source_duration=duration,
        # _FALLBACK_ARGS' own fixed -ab 192k, carried rather than left for
        # a reader to match against the content type.
        target_bitrate_kbps=_FALLBACK_BITRATE_KBPS,
    )


@dataclass
class SourceInfo:
    """What _probe_source() actually found. sample_rate/bit_depth are None
    when ffmpeg's own line didn't carry them (see _BIT_DEPTH_RE's comment) —
    resolve_output_format() then simply can't judge this source against a
    device's declared limit and leaves it untouched, the same as a device
    with no declared limit at all. bitrate_kbps is None for lossless codecs
    (see _BITRATE_RE's comment) — informational only, nothing in
    resolve_output_format() judges a source against it. No field is ever
    guessed."""

    codec: str
    sample_rate: int | None
    bit_depth: int | None
    bitrate_kbps: int | None
    # Real audio length in seconds (see _DURATION_RE), or None when the probe
    # output carried no Duration line at all — a live/endless stream, or a
    # source ffmpeg couldn't measure.
    duration: float | None = None


async def _probe_source(url: str) -> SourceInfo | None:
    """Return the source's audio codec/sample rate/bit depth, or None if
    detection fails.

    Uses `ffmpeg -i <url>` itself rather than a separate `ffprobe` call —
    ffmpeg -i with no output target still fully parses and prints the
    input's stream info (`Stream #0:0: Audio: flac, 96000 Hz, ...`) to
    stderr before exiting non-zero, which is enough to read this off of.
    The Docker image's custom minimal ffmpeg build only ships the one
    `ffmpeg` binary (see Dockerfile) — adding a second, similarly-sized
    static ffprobe binary just for this lookup isn't worth it.

    Deliberately does *not* also read the "Duration: ..., bitrate: N kb/s"
    summary line. Nothing needs it now that ffmpeg paces itself (see
    _READRATE_ARGS), and what it reports is the container bitrate, cover
    art included — a number that looks like the audio bitrate, isn't, and
    silently broke pacing for every track with a large embedded cover.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            FFMPEG_BIN,
            "-hide_banner",
            "-i",
            url,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=_PROBE_TIMEOUT)
    except Exception as e:
        logger.warning(f"[ffmpeg] format probe failed for {url[:80]}: {e}")
        return None

    match = _AUDIO_STREAM_RE.search(stderr)
    if not match:
        logger.warning(f"[ffmpeg] format probe: no audio stream detected for {url[:80]}")
        return None
    codec = match.group(1).decode()

    # Bounded to the rest of the Audio stream's own line — see
    # _SAMPLE_RATE_RE/_BIT_DEPTH_RE's own comments for why a later,
    # unrelated line (embedded cover art's own video Stream line) must
    # never be what these end up matching.
    line_end = stderr.find(b"\n", match.end())
    line = stderr[match.end() : line_end if line_end != -1 else len(stderr)]
    rate_match = _SAMPLE_RATE_RE.search(line)
    depth_match = _BIT_DEPTH_RE.search(line)
    bitrate_match = _BITRATE_RE.search(line)
    return SourceInfo(
        codec=codec,
        sample_rate=int(rate_match.group(1)) if rate_match else None,
        bit_depth=int(depth_match.group(1)) if depth_match else None,
        bitrate_kbps=int(bitrate_match.group(1)) if bitrate_match else None,
        duration=_parse_duration(stderr),
    )


def _parse_duration(probe_output: bytes) -> float | None:
    """Seconds from the probe's Duration line, or None when it has none (a
    live stream reports "N/A" there)."""
    match = _DURATION_RE.search(probe_output)
    if not match:
        return None
    hours, minutes, seconds, fraction = match.groups()
    return (
        int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(fraction) / (10 ** len(fraction))
    )


def _resample_plan(
    info: SourceInfo, max_sample_rate: int | None, max_bit_depth: int | None
) -> tuple[list[str], int | None, int | None]:
    """ffmpeg args to bring `info` down to a device's declared limits, plus
    the sample rate/bit depth those args actually produce (None for
    whichever one isn't being changed). Args are [] if nothing needs to
    change at all. Never upsamples or upgrades: a cap higher than the
    source's own rate/depth (or a source whose rate/depth couldn't be
    detected at all) leaves it alone rather than "helpfully" changing
    anything not actually required to make the device happy.

    The two returned numbers exist purely to be reported (see
    OutputFormat.target_sample_rate) — they're derived from the same
    condition as the args themselves rather than re-checked separately,
    so what the stream-info section shows can't drift from what ffmpeg was
    actually told to do."""
    args = []
    target_sample_rate = None
    target_bit_depth = None
    if (
        max_sample_rate is not None
        and info.sample_rate is not None
        and info.sample_rate > max_sample_rate
    ):
        args += ["-ar", str(max_sample_rate)]
        target_sample_rate = max_sample_rate
    if max_bit_depth is not None and info.bit_depth is not None and info.bit_depth > max_bit_depth:
        # FLAC/ALAC sources in practice are 16- or 24-bit; s16 is the only
        # meaningful "smaller" target once 24 itself isn't allowed.
        args += ["-sample_fmt", "s16"]
        target_bit_depth = 16
    return args, target_sample_rate, target_bit_depth


def _may_copy(codec: str, device_codecs: frozenset[str] | None) -> bool:
    """Whether `codec` may be stream-copied to this target.

    An unknown target is not judged — same rule the rest of this module
    follows for something it does not know — except for the codecs in
    _COPY_NEEDS_DECLARED_SUPPORT, where being wrong is silence rather than
    an error and so has to be ruled out instead."""
    if codec in _COPY_NEEDS_DECLARED_SUPPORT:
        return device_codecs is not None and codec in device_codecs
    return device_codecs is None or codec in device_codecs


def _plays_flac(device_codecs: frozenset[str] | None) -> bool:
    """Whether the lossless tiers below may produce FLAC for this target.

    True when nothing is known about the target (no delivery active), same
    as every other device check here: an unknown device is not judged, it
    is left alone. Every delivery Beacon ships does play FLAC, so this only
    guards a future one that does not — and guards it against silence
    rather than against an error message."""
    return device_codecs is None or "flac" in device_codecs


def _exceeds_quality_ceiling(
    info: SourceInfo, max_lossy_format: str | None, max_lossy_bitrate_kbps: int | None
) -> bool:
    """Whether `info` is bigger than the listener's quality ceiling and so
    has to be re-encoded down to it.

    Three cases, and the third is the one worth stating: a lossy source
    whose own bitrate ffmpeg didn't report is left alone. Guessing "it's
    probably above the ceiling" would re-encode an already-small file for
    nothing, and guessing the other way is no better founded — same rule
    the rest of this module follows for a number it doesn't have (see
    SourceInfo's own docstring)."""
    if not max_lossy_format or not max_lossy_bitrate_kbps:
        return False
    if max_lossy_format not in _LOSSY_ENCODERS:
        logger.warning(f"[ffmpeg] Ignoring unknown quality ceiling format '{max_lossy_format}'")
        return False
    if info.codec in _LOSSLESS_CODECS:
        return True
    return info.bitrate_kbps is not None and info.bitrate_kbps > max_lossy_bitrate_kbps


def _lossy_ceiling_format(
    info: SourceInfo,
    fmt: str,
    bitrate_kbps: int,
    max_sample_rate: int | None,
) -> OutputFormat:
    """The re-encode a source over the listener's ceiling lands on.

    No `_resample_plan()` args here, unlike the FLAC tiers: a lossy encode
    picks its own output rate anyway (see _lossy_sample_rate(), which is
    handed the device's ceiling and honours it), and its bit depth is
    whatever the encoder produces — `-sample_fmt s16` would be rejected by
    libmp3lame rather than respected."""
    args, content_type = lossy_encode_args(fmt, bitrate_kbps, info.sample_rate, max_sample_rate)
    logger.info(
        f"[ffmpeg] format probe: '{info.codec}' "
        f"{f'{info.bitrate_kbps}kbps ' if info.bitrate_kbps else ''}"
        f"exceeds the {fmt} {bitrate_kbps}kbps quality ceiling — re-encoding"
    )
    return OutputFormat(
        ffmpeg_args=args,
        content_type=content_type,
        label=f"{info.codec} → {fmt} {bitrate_kbps}k (quality ceiling)",
        source_codec=info.codec,
        source_sample_rate=info.sample_rate,
        source_bit_depth=info.bit_depth,
        source_bitrate_kbps=info.bitrate_kbps,
        source_duration=info.duration,
        target_sample_rate=_lossy_sample_rate(fmt, info.sample_rate, max_sample_rate),
        target_bitrate_kbps=bitrate_kbps,
        transcode_reason=REASON_QUALITY_LIMIT,
    )


async def resolve_output_format(
    url: str,
    gain: float = 1.0,
    max_sample_rate: int | None = None,
    max_bit_depth: int | None = None,
    max_lossy_format: str | None = None,
    max_lossy_bitrate_kbps: int | None = None,
    device_codecs: frozenset[str] | None = None,
) -> OutputFormat:
    """Detect the real source codec/sample rate/bit depth and decide how
    ffmpeg should handle it — stream-copy when the source is already
    device-compatible (preserving its exact quality/bitrate), lossless
    re-encode to FLAC (resampled down to a device's limit when it has one
    and the source exceeds it) for other lossless sources, or the existing
    MP3 192k re-encode as the universal fallback when detection fails or the
    source is something else entirely (never a new failure mode, only ever
    an upgrade when detection succeeds).

    `max_sample_rate`/`max_bit_depth` are the casting target's own declared
    ceiling — see delivery/base.py's BaseDelivery.MAX_SAMPLE_RATE_HZ/
    MAX_BIT_DEPTH and core/state.py's audio_capability_limits(), which every
    caller here is expected to have already reduced a (possibly multi-
    target) dispatch down to the single most restrictive pair. None (the
    default) means no known limit — every caller from before these
    parameters existed keeps behaving exactly as it did.

    A source that exceeds either is never stream-copied, even when its
    codec would otherwise qualify: copying means the device gets the
    file's own bytes untouched, and there's no such thing as a device-
    compatible copy of a stream whose sample rate the device can't decode
    at all — confirmed live (see
    docs/investigations/copy-tier-device-limits.md): a 24-bit/96kHz FLAC
    copied straight to a Sonos reported ERROR_UNSUPPORTED_FREQ and stopped
    1.1s in. It's re-encoded losslessly to FLAC instead, resampled down to
    the limit — the same tier _LOSSLESS_REENCODE_CODECS below already
    uses, just also reached from a codec that would otherwise have
    qualified for copy.

    `gain` (ReplayGain, see stream_tracks()'s own docstring) rules out the
    copy tier specifically: stream-copy means ffmpeg never decodes the
    audio at all, and applying a volume adjustment requires exactly that —
    `ffmpeg -af volume=X -acodec copy` fails outright ("Filtering and
    streamcopy cannot be used together"), which meant a ReplayGain-enabled
    track that also happened to qualify for stream-copy never played at
    all. Every FLAC re-encode tier below is unaffected either way — it
    already decodes+re-encodes, so stream_tracks() fits a volume filter
    into that same pipeline for free (see its own handling of `gain`).

    `max_lossy_format`/`max_lossy_bitrate_kbps` are the *listener's* ceiling
    rather than the device's — the quality setting in the frontend, carried
    here from /play (see routes/playback.py). Both must be given together
    for either to do anything. They cap the tiers below instead of replacing
    them: a source that already fits stays exactly where it would have
    landed, so an mp3-192k source under a 320k ceiling is still copied
    untouched. Only a source above the ceiling is re-encoded down to it, and
    a lossless source is always above it, whatever number it names.

    The device's own limits above still win where they disagree, and that
    ordering is deliberate: `max_sample_rate` is what a device can decode at
    all, so ignoring it produces silence (see the ERROR_UNSUPPORTED_FREQ
    case above), while ignoring the listener's ceiling only produces a
    bigger stream than they asked for.

    `device_codecs` is the same idea one level up: which codecs the target
    can decode at all (BaseDelivery.PLAYABLE_CODECS, reduced across every
    active target by core/state.py's playable_codecs()). It decides both
    halves of what leaves here — a source is only copied to a device that
    plays its codec, and a quality ceiling naming a format the device
    cannot decode is encoded as the best one it can (see
    _codec_for_ceiling()). That is what makes Opus offerable as a setting
    at all: it reaches a Chromecast as Opus and a Sonos as AAC, rather than
    reaching a Sonos as a URI it accepts and then plays silently. None (the
    default) means no target is known, and nothing is judged against it."""
    info = await _probe_source(url)
    if info is None:
        return _fallback(REASON_PROBE_FAILED)
    codec = info.codec
    # Before the plan below rather than inside it: this is a property of the
    # source format, not of any device, and every tier past this point has to
    # see the same ceiling.
    max_sample_rate = dsd_sample_rate_cap(codec, max_sample_rate)
    resample_args, target_rate, target_depth = _resample_plan(info, max_sample_rate, max_bit_depth)

    if _exceeds_quality_ceiling(info, max_lossy_format, max_lossy_bitrate_kbps):
        return _lossy_ceiling_format(
            info,
            _codec_for_ceiling(max_lossy_format, device_codecs),
            max_lossy_bitrate_kbps,
            max_sample_rate,
        )

    muxer = _COPY_MUXER_FOR_CODEC.get(codec)
    # _COPY_MUXER_FOR_CODEC says what *can* be copied; this says whether
    # this particular target can play it. The two used to be the same
    # question, which is how an AAC source reached an AirPlay device it
    # has never been able to decode (see AirPlayDelivery.PLAYABLE_CODECS)
    # — copied straight through, announced correctly, and silent.
    if muxer and not _may_copy(codec, device_codecs):
        plays = (
            "nothing is known about this target"
            if device_codecs is None
            else (f"this target plays only {sorted(device_codecs)}")
        )
        logger.info(
            f"[ffmpeg] format probe: '{codec}' could be copied, but {plays} — using mp3 fallback"
        )
        return _fallback(REASON_CODEC_NOT_CASTABLE, info.duration)
    if muxer and resample_args and not _plays_flac(device_codecs):
        # The resample below has to happen — the source is past what this
        # device can decode — but its usual lossless landing place is out.
        logger.info(
            f"[ffmpeg] format probe: '{codec}' exceeds this target's limit and it does not "
            "play flac — using mp3 fallback"
        )
        return _fallback(REASON_DEVICE_LIMIT, info.duration)
    if muxer and resample_args:
        logger.info(
            f"[ffmpeg] format probe: '{codec}' would copy, but source "
            f"{info.sample_rate}Hz/{info.bit_depth}bit exceeds this target's limit "
            f"({max_sample_rate}Hz/{max_bit_depth}bit) — re-encoding to flac, resampled"
        )
        flac_args, flac_type = lossless_encode_args(resample_args)
        return OutputFormat(
            ffmpeg_args=flac_args,
            content_type=flac_type,
            label=f"{codec} → flac (resampled for device limit)",
            source_codec=info.codec,
            source_sample_rate=info.sample_rate,
            source_bit_depth=info.bit_depth,
            source_bitrate_kbps=info.bitrate_kbps,
            source_duration=info.duration,
            target_sample_rate=target_rate,
            target_bit_depth=target_depth,
            transcode_reason=REASON_DEVICE_LIMIT,
        )
    if muxer and gain == 1.0:
        return OutputFormat(
            ffmpeg_args=["-acodec", "copy", "-f", muxer],
            content_type=_CONTENT_TYPE_FOR_MUXER[muxer],
            label=f"{codec} (copy)",
            source_codec=info.codec,
            source_sample_rate=info.sample_rate,
            source_bit_depth=info.bit_depth,
            source_bitrate_kbps=info.bitrate_kbps,
            source_duration=info.duration,
        )
    if muxer:
        logger.info(
            f"[ffmpeg] format probe: '{codec}' would copy, but ReplayGain is active "
            "(gain != 1.0) — using mp3 fallback instead, since streamcopy and a volume "
            "filter can't be combined"
        )
        return _fallback(REASON_REPLAY_GAIN, info.duration)

    if codec in _LOSSLESS_REENCODE_CODECS:
        if not _plays_flac(device_codecs):
            logger.info(
                f"[ffmpeg] format probe: lossless '{codec}' would become flac, which this "
                "target does not play — using mp3 fallback"
            )
            return _fallback(REASON_CODEC_NOT_CASTABLE, info.duration)
        label = f"{codec} → flac" + (" (resampled for device limit)" if resample_args else "")
        flac_args, flac_type = lossless_encode_args(resample_args)
        return OutputFormat(
            ffmpeg_args=flac_args,
            content_type=flac_type,
            label=label,
            source_codec=info.codec,
            source_sample_rate=info.sample_rate,
            source_bit_depth=info.bit_depth,
            source_bitrate_kbps=info.bitrate_kbps,
            source_duration=info.duration,
            target_sample_rate=target_rate,
            target_bit_depth=target_depth,
            # Both are true for a resampled one; the device limit is the
            # more specific (and more actionable) of the two, so it wins.
            transcode_reason=(REASON_DEVICE_LIMIT if resample_args else REASON_LOSSLESS_CONTAINER),
        )

    # Everything reaching here is a codec no tier above recognised: not
    # copyable, not lossless. A source a *target* cannot play never gets this
    # far — that is answered at the copy guard, where the device's own codec
    # list is known.
    logger.info(f"[ffmpeg] format probe: unrecognized codec '{codec}', using mp3 fallback")
    return _fallback(REASON_CODEC_UNKNOWN, info.duration)


async def stream_tracks(
    track_urls: list[str],
    on_track_start: Callable[[int], None] | None = None,
    start_offset: float = 0.0,
    gain: float = 1.0,
    output_format: OutputFormat | None = None,
) -> AsyncGenerator[bytes]:
    """Yield continuous audio bytes for all tracks in sequence, encoded per
    `output_format` (defaults to the MP3 192k fallback — see resolve_output_format()).

    Calls on_track_start(relative_index) before each track begins.
    start_offset seeks the first track to that many seconds in (e.g. after pause/resume).
    gain is a linear amplitude multiplier (ReplayGain), applied via ffmpeg's
    `volume` filter — 1.0 (the default) leaves the audio unchanged.

    Paced to at most LOOKAHEAD_SECONDS ahead of real playback by ffmpeg
    itself — see _READRATE_ARGS, which every tier's command carries.
    Without pacing, ffmpeg happily produces output as fast as the source
    can be fetched and decoded, not at anything close to real time. That
    was never a problem for the old always-re-encode pipeline this one
    replaced — actual decode+encode CPU work incidentally kept it roughly
    real-time-ish on its own — but the `-acodec copy` tier this one added
    (real quality win: zero re-encode loss, see resolve_output_format())
    does essentially no CPU work at all, so a long track gets fully
    produced and handed off to the device in seconds. Observed live
    2026-08-22: several-minutes-long stretches of a cast device's GET
    /stream connection sitting completely idle (everything already sent
    long before actual playback caught up) ending in the device dropping
    it outright — some idle-connection timeout somewhere between here and
    the device, not this app's own code, but avoidable either way by
    simply not producing that far ahead of real consumption in the first
    place. A device reconnecting after a drop only ever has to recover
    this many seconds of buffer, not the rest of a multi-hour file either.
    """
    if not track_urls:
        return

    fmt = output_format or FALLBACK_FORMAT
    # -ar 44100 (the fallback's forced resample) must never leak onto the
    # copy/lossless-flac branches — that would silently defeat the point for
    # any source above 44.1kHz/16-bit. Those branches simply don't carry it.
    fmt_args = fmt.ffmpeg_args

    for i, url in enumerate(track_urls):
        if on_track_start:
            on_track_start(i)

        cmd = [arg if arg != "{url}" else url for arg in _FFMPEG_BASE_CMD]
        # Input options, so before -i — same insertion the -ss below does.
        i_pos = cmd.index("-i")
        cmd = cmd[:i_pos] + http_reconnect_args(url) + cmd[i_pos:]
        cmd = cmd + fmt_args + ["pipe:1"]
        if i == 0 and start_offset > 0.5:
            # Insert -ss before -i for fast input-side seeking on the resumed track
            i_pos = cmd.index("-i")
            cmd = cmd[:i_pos] + ["-ss", f"{start_offset:.3f}"] + cmd[i_pos:]
        if gain != 1.0:
            i_pos = cmd.index("-vn")
            cmd = cmd[:i_pos] + ["-af", f"volume={gain}"] + cmd[i_pos:]
        logger.debug(f"[ffmpeg] Track {i + 1}/{len(track_urls)} ({fmt.label}): {url[:80]}")
        logger.debug(f"[ffmpeg] Command: {' '.join(cmd)}")

        proc = None
        stderr_task: asyncio.Task | None = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            # Read stderr concurrently to prevent pipe buffer deadlock
            stderr_task = asyncio.create_task(proc.stderr.read())

            # Pacing itself is ffmpeg's job now (see _READRATE_ARGS), so
            # this loop just moves bytes. Reset per track — each is its own
            # ffmpeg invocation with its own timeline. Kept only to log the
            # summary below, which is the cheapest way to notice pacing
            # having regressed again: for a paced stream, wall time to
            # produce a track lands within ~LOOKAHEAD_SECONDS of that
            # track's real duration, not a fraction of it.
            track_start = time.monotonic()
            bytes_produced = 0
            while True:
                chunk = await proc.stdout.read(8192)
                if not chunk:
                    break
                bytes_produced += len(chunk)
                yield chunk

            logger.debug(
                f"[ffmpeg] Track {i + 1} produced {bytes_produced} bytes in "
                f"{time.monotonic() - track_start:.1f}s wall"
            )
            await proc.wait()
            stderr = await stderr_task

            if proc.returncode != 0:
                logger.warning(
                    f"[ffmpeg] Track {i + 1} exit {proc.returncode}: "
                    f"{stderr.decode(errors='replace')[:400]}"
                )
            elif stderr:
                logger.debug(
                    f"[ffmpeg] Track {i + 1} stderr: {stderr.decode(errors='replace')[:200]}"
                )

        except FileNotFoundError:
            logger.error("[ffmpeg] ❌ ffmpeg not found — please install (apk add ffmpeg)")
            # Propagate (not a silent `return`) so stream_with_completion()
            # doesn't mistake this for a normal, successful end-of-stream and
            # fire a track-end broadcast — see its matching except clause.
            raise

        except asyncio.CancelledError:
            logger.info(f"[ffmpeg] Stream cancelled (Track {i + 1})")
            if proc:
                try:
                    proc.kill()
                except Exception as e:
                    logger.debug(f"[ffmpeg] kill after cancellation failed: {e}")
            if stderr_task:
                stderr_task.cancel()
            raise  # propagate so stream_with_completion skips the track-end broadcast

        except Exception:
            logger.exception(f"[ffmpeg] Error on track {i + 1}")
            if proc:
                try:
                    proc.kill()
                except Exception as e:
                    logger.debug(f"[ffmpeg] kill after error failed: {e}")
            # Propagate rather than `continue` — a genuine ffmpeg failure
            # (crash, decode error) is not a natural end either; see the
            # FileNotFoundError branch above for why this matters.
            raise

    logger.info("[ffmpeg] All tracks streamed")
