"""routes/debug.py — Diagnostic-only endpoints, not part of the app's real
feature set.

GET /debug/test-tone.wav + POST /debug/play-test-tone: swaps whatever's
currently playing/casting for a synthesized test signal — silence with a
short beep every _INTERVAL_S seconds, cycling through the distinct pitches
in _TONE_SEQUENCE_HZ. Built for reading off exactly how far the fullscreen
visualizer's 'cast' mode timing is out, and in which direction, against
cues whose onset is known in advance — far easier to judge than a real
track's fuzzy transients.

The pitches are what make the reading unambiguous, and that was learned the
hard way: with one repeated beep, "a second early" and "an interval minus a
second late" are indistinguishable, which invalidated the first lead figure
measured this way (2026-09-05). Hearing *which* pitch sounds while watching
*which* bar lights names the beep outright — see _TONE_SEQUENCE_HZ.

Goes through the exact same /stream -> ffmpeg -> AudioAnalyzer pipeline as
a real track (see routes/stream.py's TEST_TONE_TRACK_ID special case) —
only the source audio differs, not any of the analysis/pacing machinery
being diagnosed.

GET /debug/test-radio: the same idea aimed at the path that actually has
the timing problem. Everything above dispatches a *track*, and a track's
clock is calibrated against the device's own reported position
(routes/playback.py's position-resync), which is why track playback is in
sync and has stayed that way. Radio has no such feedback for a relayed
Sonos — core/state.py's first_radio_position_delivery() excludes it,
leaving core/visualizer_feed.py's _FirstByteClock running on an estimated
device lead — so a test signal dispatched as a track exercises none of the
machinery under suspicion. This endpoint is an endless, real-time-paced
station instead: point /play-url at it and it goes through RadioRelay,
x-rincon-mp3radio:// dispatch, IcyMuxer and _FirstByteClock exactly as
rockantenne.de would, but playing audio whose content is known in advance.

Its source is the generated beep by default, or a file from
BEACON_TEST_AUDIO_DIR when that is configured and one is named — see
_test_audio_dir(). Deliberately a directory the operator supplies rather
than anything shipped here: useful test material is somebody else's
copyrighted audio more often than not, and this repo neither carries nor
redistributes any. Unset (the default), only the generated beep is
available, which is the better signal for timing anyway.
"""

import asyncio
import io
import logging
import math
import os
import struct
import time
import wave
from collections.abc import AsyncGenerator
from pathlib import Path

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import StreamingResponse

from core.icy_metadata import DEVICE_METAINT, IcyMuxer
from core.session import SessionState, build_status_dict, require_authenticated_session
from core.state import TEST_TONE_TRACK_ID, stream_url, test_tone_url
from core.streamer import FALLBACK_FORMAT
from media.base import Track

from .playback import _apply_position_offset

logger = logging.getLogger("connect.debug")
router = APIRouter(prefix="/debug")

# Where POST /play-test-tone looks for local audio files, when set. Not a
# setting with a default: a directory of audio this repo does not own, does
# not ship, and must not redistribute — the operator points this at their
# own material or the feature simply isn't there. Read on every request
# rather than captured at import so it can be set without a restart.
_TEST_AUDIO_ENV = "BEACON_TEST_AUDIO_DIR"

# Extensions offered from that directory. ffmpeg decodes far more than
# this; the list exists so a directory that also holds notes, cover art or
# a licence file lists only the audio in it.
_TEST_AUDIO_SUFFIXES = (".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus")


def _test_audio_dir() -> Path | None:
    raw = os.environ.get(_TEST_AUDIO_ENV)
    if not raw:
        return None
    path = Path(raw).expanduser()
    return path if path.is_dir() else None


def _test_audio_files() -> list[str]:
    """Sorted file names available to play, or empty when the directory
    isn't configured/present. Names only, never paths — see
    _resolve_test_audio() for why the caller never gets to supply one."""
    directory = _test_audio_dir()
    if directory is None:
        return []
    return sorted(
        f.name
        for f in directory.iterdir()
        if f.is_file() and f.suffix.lower() in _TEST_AUDIO_SUFFIXES
    )


def _resolve_test_audio(name: str) -> Path | None:
    """The file `name` refers to inside the configured directory, or None
    if there is no such file.

    Matched against _test_audio_files() rather than joined onto the
    directory and opened: a name is caller-supplied, and joining one
    containing "../" (or an absolute path, which Path.__truediv__ silently
    lets win outright) would read anything the process can reach. Comparing
    against a listing of the directory's own entries cannot escape it, and
    needs no separate traversal check to be right."""
    directory = _test_audio_dir()
    if directory is None or name not in _test_audio_files():
        return None
    return directory / name


_SAMPLE_RATE = 44100
_DURATION_S = 600  # long enough to not run out mid-session
_BEEP_S = 0.3

# One beep every this many seconds. Short enough that a whole cycle can be
# watched in under half a minute; long enough that consecutive beeps stay
# individually distinguishable through a device buffer of several seconds.
_INTERVAL_S = 2.0

# The pitches those beeps cycle through, and the reason this is a sequence
# rather than one repeated tone.
#
# A single fixed beep cannot answer the question it is for. Every beep looks
# and sounds exactly like every other, so "the visualizer is a second ahead"
# and "the visualizer is a whole interval minus a second behind" are the
# same observation — reported live 2026-09-05, and it invalidated the first
# lead figure measured this way. With distinct pitches there is nothing to
# confuse: the pitch being *heard* names which beep it is, so the offset
# against what is on screen reads off directly and unambiguously.
#
# Octave steps specifically, spanning most of the audible range, because
# the reading is done against the visualizer's own bars: its bands are
# spaced roughly logarithmically (see core/audio_analysis.py), so each of
# these lands in a clearly different one — low tones to the left, high to
# the right. Exact octaves of A, from 110Hz to 7040Hz: both ends stay
# within what an ordinary speaker actually reproduces, which a lower or
# higher step would not. A listener sees which bar lit and hears which pitch sounded,
# and those two disagreeing *is* the measurement.
#
# Seven of them at _INTERVAL_S apart makes a 14-second cycle. Anything
# beyond that would have to be an unusually large error to be ambiguous
# again, and at that size the sequence position gives it away anyway.
_TONE_SEQUENCE_HZ = (110.0, 220.0, 440.0, 880.0, 1760.0, 3520.0, 7040.0)


def _beep(freq_hz: float) -> bytes:
    """One `_BEEP_S` burst of `freq_hz`, faded at both ends.

    The fade is short and linear so the beep has no click of its own —
    a click is a broadband transient that lights every visualizer band at
    once, which would hide the very thing the distinct pitches are for."""
    beep_samples = int(_BEEP_S * _SAMPLE_RATE)
    ramp = min(200, beep_samples // 4) or 1
    out = bytearray(beep_samples * 2)
    for i in range(beep_samples):
        envelope = min(1.0, i / ramp, (beep_samples - i) / ramp)
        sample = int(envelope * 32767 * math.sin(2 * math.pi * freq_hz * i / _SAMPLE_RATE))
        struct.pack_into("<h", out, i * 2, sample)
    return bytes(out)


def _generate_test_tone_wav() -> bytes:
    beep_samples = int(_BEEP_S * _SAMPLE_RATE)
    interval_samples = int(_INTERVAL_S * _SAMPLE_RATE)
    silence_samples = interval_samples - beep_samples

    beeps = [_beep(f) for f in _TONE_SEQUENCE_HZ]
    silence = bytes(silence_samples * 2)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(_SAMPLE_RATE)
        for n in range(int(_DURATION_S / _INTERVAL_S)):
            wav.writeframes(beeps[n % len(beeps)])
            wav.writeframes(silence)
    return buf.getvalue()


# Generated once, on first request — deterministic content, no reason to
# regenerate it (~800KB, trivial to hold in memory for the process lifetime).
_cached_wav: bytes | None = None


@router.get("/test-tone.wav")
async def test_tone_wav() -> Response:
    global _cached_wav
    if _cached_wav is None:
        _cached_wav = _generate_test_tone_wav()
    return Response(content=_cached_wav, media_type="audio/wav")


@router.post("/play-test-tone")
async def play_test_tone(session: SessionState = Depends(require_authenticated_session)):
    """Swaps the current session's *already-active* delivery target onto
    the test tone — reuses whatever device is already connected/claimed
    rather than resolving/claiming a new one, so start by playing
    something normal first (join a device, hit play), then call this."""
    st = session.state
    target = st.active_delivery
    if not target:
        return {"error": "No active delivery — connect a device and start playing something first"}

    st.current_track = Track(
        id=TEST_TONE_TRACK_ID,
        title="Test Tone",
        artist="Debug",
        duration=_DURATION_S,
    )
    st.current_track_gain = 1.0
    # Always the plain mp3 fallback here, regardless of whatever a previous
    # real track resolved — the synthesized WAV can't be stream-copied into
    # a leftover FLAC/AAC/OGG decision from before (see core/streamer.py's
    # resolve_output_format()), and this debug beep has no reason to be lossless.
    st.current_output_format = FALLBACK_FORMAT
    st.is_streaming = True
    st.radio_info = None
    st.clock.start(0.0)
    st.track_ended = False

    url = stream_url(session.session_id)
    try:
        await target.play(url, "Test Tone", "Debug", None, float(_DURATION_S), "")
    except Exception as e:
        logger.exception("[debug] play-test-tone delivery error")
        return {"error": str(e)}

    asyncio.create_task(_apply_position_offset(session, target, st.clock.play_generation))
    logger.info(f"[debug] ▶ test tone — {len(_TONE_SEQUENCE_HZ)} pitches, one every {_INTERVAL_S}s")
    await session.event_bus.broadcast(build_status_dict(session))
    return {
        "status": "playing",
        "interval_seconds": _INTERVAL_S,
        "pitches_hz": list(_TONE_SEQUENCE_HZ),
    }


# Cadence of the ICY StreamTitle markers the test station injects. Matches
# core/icy_metadata.py's own ICY_PULSE_SECONDS so what a device echoes back
# here arrives on the same rhythm a real cast produces — the point is to
# exercise that path, not a faster synthetic one.
_MARKER_INTERVAL_S = 8.0

# Bitrate the station encodes at. 128k is what the great majority of real
# MP3 stations serve, and it sets how much wall-clock audio a given number
# of bytes is worth — which is exactly what every buffer in the chain is
# measured in.
_STATION_BITRATE = "128k"


def _station_cmd(source: str) -> list[str]:
    """ffmpeg reading `source` on an endless loop, paced to real time,
    encoded to constant-bitrate MP3.

    -re is the whole point: without it ffmpeg encodes as fast as it can
    read, the response generator hands that to whoever is fetching at the
    same speed, and every buffer downstream (this process's socket, the
    relay's queue, the device's own) fills with minutes of audio in
    seconds. A station that outruns real time makes every timing number
    measured against it meaningless, which is precisely the class of error
    this endpoint exists to help find.

    -stream_loop -1 so a three-minute file behaves like a station rather
    than ending; RadioRelay treats an ended stream as a station that
    dropped and reconnects, which would restart the audio at an unrelated
    moment mid-measurement."""
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        "-stream_loop",
        "-1",
        "-i",
        source,
        "-vn",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-b:a",
        _STATION_BITRATE,
        # A real Icecast stream is a bare sequence of MP3 frames, and both
        # of these would make this one measurably less like it. -write_xing
        # 0 drops the Xing/Info header, which carries a *frame count* — i.e.
        # a duration — for what is supposed to be an endless broadcast, and
        # a device that believes it knows the length may well decide how to
        # buffer accordingly. -id3v2_version 0 drops the ID3 tag ffmpeg
        # otherwise puts in front of the first frame; stations do not send
        # one, and the point of this endpoint is to be indistinguishable
        # from one that does.
        "-write_xing",
        "0",
        "-id3v2_version",
        "0",
        "-f",
        "mp3",
        "pipe:1",
    ]


async def _station_audio(source: str, metaint: int) -> AsyncGenerator[bytes]:
    """The station's body: ffmpeg's MP3 output with an ICY metadata block
    spliced in every `metaint` bytes, carrying a counter that increments
    every _MARKER_INTERVAL_S.

    A counter rather than a fixed title, because that is what makes the
    round trip measurable: routes/upnp.py records when each title went out
    and matches it against the device echoing the same one back, so a
    title that never changes yields exactly one sample per cast. This is
    the same trick scripts/icy_sync_probe.py used to get 36 samples where
    an ordinary station gives one every few minutes — except here the
    markers travel the real relay/mux/dispatch path rather than a probe's
    own connection.

    Reuses IcyMuxer rather than writing the blocks inline, so the framing
    under test is the framing production actually serves."""
    started = time.monotonic()

    def marker() -> str:
        return f"BEACON TEST {int((time.monotonic() - started) // _MARKER_INTERVAL_S):04d}"

    muxer = IcyMuxer(metaint, marker)
    proc = await asyncio.create_subprocess_exec(
        *_station_cmd(source), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
    )
    logger.info(f"[debug] 📻 test station started from {source}")
    try:
        while True:
            chunk = await proc.stdout.read(8192)
            if not chunk:
                return
            yield muxer.feed(chunk)
    finally:
        # The listener disconnecting has to take the encoder with it —
        # otherwise every /play-url retry leaves another paced ffmpeg
        # running for the lifetime of the process.
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        logger.info("[debug] 📻 test station stopped")


@router.get("/test-radio")
async def test_radio(request: Request, file: str | None = None) -> Response:
    """An endless internet-radio station serving known audio — see this
    module's own docstring for why the timing question needs one.

    Use it by casting it as radio: POST /play-url with this endpoint's URL
    (http://<lan-ip>:<port>/debug/test-radio) and it is relayed,
    dispatched and analyzed exactly like any station from the Radio page.

    `file` picks a name from BEACON_TEST_AUDIO_DIR; omitted (or with that
    directory unconfigured) it serves the generated beep, which is the
    better signal for judging *timing* — a beep every 10s has an
    unambiguous onset, where music does not. A named file is for the other
    question: whether the bands respond correctly to real material.

    Answers Icy-MetaData: 1 the same way a real station does, so the whole
    ICY path — IcyMuxer's framing, the device's echo, routes/upnp.py's
    round-trip estimate — is exercised rather than bypassed."""
    if file is not None:
        resolved = _resolve_test_audio(file)
        if resolved is None:
            available = _test_audio_files()
            return Response(
                content=(
                    f"No such test file {file!r}. "
                    + (
                        f"Available: {', '.join(available)}"
                        if available
                        else f"Set {_TEST_AUDIO_ENV} to a directory of audio files first."
                    )
                ),
                status_code=404,
                media_type="text/plain",
            )
        source = str(resolved)
    else:
        source = test_tone_url()

    wants_icy = request.headers.get("icy-metadata") == "1"
    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    if wants_icy:
        headers["icy-metaint"] = str(DEVICE_METAINT)
        headers["icy-name"] = "Beacon Test Station"
    # metaint only matters when the client asked for metadata; without the
    # header a client expects pure audio, and splicing blocks into it
    # anyway would corrupt the stream.
    body = _station_audio(source, DEVICE_METAINT) if wants_icy else _station_audio_plain(source)
    return StreamingResponse(body, media_type="audio/mpeg", headers=headers)


async def _station_audio_plain(source: str) -> AsyncGenerator[bytes]:
    """_station_audio() without the ICY blocks, for a client that did not
    ask for them — the local player in a browser, or curl."""
    proc = await asyncio.create_subprocess_exec(
        *_station_cmd(source), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
    )
    try:
        while True:
            chunk = await proc.stdout.read(8192)
            if not chunk:
                return
            yield chunk
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


@router.get("/test-audio")
async def list_test_audio() -> dict:
    """What `file` may be set to on /test-radio above. Empty (with the
    directory reported as None) whenever BEACON_TEST_AUDIO_DIR isn't set,
    which is the default and not an error."""
    directory = _test_audio_dir()
    return {
        "directory": str(directory) if directory else None,
        "env_var": _TEST_AUDIO_ENV,
        "files": _test_audio_files(),
    }
