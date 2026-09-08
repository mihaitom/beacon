"""routes/local_stream.py — transcoded audio for Beacon's *own* player.

The frontend's `<audio>` element normally fetches a track straight from the
media server through routes/proxy.py, byte for byte. That is the right
default and stays untouched (see streamUrl() in
services/subsonic/client.ts, which only points here once the listener has
asked for something other than "original"), but it leaves two things
impossible:

- **Playing what the browser can't decode.** An ALAC, APE or WavPack source
  simply does not play in Chrome or Firefox. Cast targets have had a
  transcode path for this since the stream-copy tiers were added
  (core/streamer.py's resolve_output_format()); the local player never did.
- **Choosing a smaller stream.** The web build on a phone pulls whatever the
  library holds — 24/96 FLAC included — with no way to ask for less.

This route answers both with the same ffmpeg pipeline core/streamer.py
already uses for casting, one track at a time instead of a queue.

**Seeking is the constraint that shapes everything here.** AudioEngine.seek()
sets `audio.currentTime`, which a browser can only do if the response has a
length and accepts byte ranges. A transcode has neither on its own: nothing
knows how long the output will be until it has been produced. Both are
recovered by encoding at a *constant* bitrate, which makes byte offsets and
timestamps the same information in two units — the length is
`transcoded_byte_length()`, and a `Range` request's start byte divided by
the same bitrate is the second to seek ffmpeg to.

That constraint is also why this route offered exactly one format for as
long as it did: FLAC has no predictable length at all, and — measured, not
assumed — neither ffmpeg's aac encoder nor its opus one actually holds the
bitrate it is given (see ALLOWED_BITRATES below for the numbers). An output
that misses its bitrate plays perfectly and then seeks to the wrong place.
A caller that passes `start` in seconds takes the seeking over instead, and
nothing then maps bytes onto time — which is what let aac and opus be
offered here at all. The `Range` path stays for a caller that does not, and
stays mp3-shaped for the same reason it always was.

No pacing (core/streamer.py's _READRATE_ARGS) on this path, deliberately.
Those exist so a cast device isn't handed an hour of audio in one go over a
connection that then sits idle long enough for something in between to close
it. A browser holds its own buffer and wants it filled — and it is worth
knowing how much it takes, because it is the whole of what a listener on a
flaky connection is riding on. Measured against Chromium 151 (a response
shaped exactly like this one, served as fast as it was taken, then cut off):
about 9.5 MiB accepted before the browser stops reading, whatever the
bitrate — seven minutes of audio at 192k mp3, the same at 128k opus, over
thirteen at 96k. A full 18-second network outage played straight through it
without the element reporting so much as a 'waiting'. That budget is in
bytes rather than seconds, which is the argument for this route existing at
all: the same 9.5 MiB is half a minute of a 24/96 FLAC fetched untouched.
"""

import asyncio
import logging
import re
import time

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from core.auth import require_token
from core.ffmpeg import FFMPEG_BIN
from core.session import SessionState, require_authenticated_session
from core.streamer import (
    SourceInfo,
    _probe_source,
    dsd_resample_args,
    http_reconnect_args,
    lossless_encode_args,
    lossy_encode_args,
    transcoded_byte_length,
)

logger = logging.getLogger("connect.streamer")

router = APIRouter(dependencies=[Depends(require_token)])

# Formats offered here, and the bitrates each one may be asked for.
#
# Two formats now, and the reason the second one arrived is worth keeping:
# for a long time this was mp3 only, because the length this route declares
# was `bitrate x duration` (see transcoded_byte_length()) and a media
# element seeking against that length only lands correctly while the
# encoder really produces that many bytes. Only mp3 does, and only because
# LAME's CBR mode pads every frame to size whatever the music is - measured
# against ffmpeg 9.0.1, 180s at 44.1kHz stereo, and the numbers say
# something about the *signal* rather than about the encoders:
#
#     signal                        mp3 320     aac 256
#     pink noise, channels equal     +0.04%     -12.9%  (saturates ~223k)
#     pink noise, channels apart     +0.04%      +1.1%
#     a few sine tones, a chord      +0.04%      -6.4%  (saturates ~240k)
#
# ffmpeg is behaving correctly there: `-b:a` is a target its rate control
# aims at, and where two channels carry the same signal (mid/side makes one
# nearly free) or the spectrum is a handful of lines, there is nothing left
# to spend bits on. Ask for 320k on those and the file does not grow at
# all. Real music decorrelates and fills its spectrum, so it lands on its
# target - but "usually" is not something a seek can be built on, and a
# sparse or near-mono track would undershoot silently.
#
# What changed is that the seeking no longer goes through that arithmetic:
# a caller passes `start` in seconds and gets a stream that begins there
# with no length at all (see local_stream()'s docstring, and the frontend's
# startLocalSong()). Nothing has to agree about bytes, so a format can be
# chosen for how it sounds per bit, which is what aac and opus are both
# here for. opus goes lowest of the three: 96k of it is what the others
# need 192k for, which is the difference that matters on a phone away from
# home. Its own +0.81% at 128k in the table above was Ogg page framing, and
# that no longer matters either now that nothing divides bytes by seconds.
#
# Bounded rather than passed through to ffmpeg either way: `br` arrives
# from a query string, and an arbitrary integer there would let a caller
# ask for a 3000kbps mp3 that no encoder produces and no listener wanted.
ALLOWED_BITRATES: dict[str, tuple[int, ...]] = {
    "mp3": (320, 256, 192, 128, 96),
    "aac": (256, 192, 128, 96),
    "opus": (192, 128, 96, 64),
}

# The fourth format, and the one that carries no bitrate at all: a lossless
# re-encode, for a source the browser cannot decode while the listener has
# asked for **Original** (see plan() in services/streamQuality.ts). Every
# other setting rescues such a source by converting it to the chosen lossy
# format; Original had no answer and simply played nothing, which on a
# library of ALAC — or of Ogg on an iPhone — is the default setting being
# silent.
#
# FLAC because it is the only answer that keeps Original honest: the
# container changes, nothing else does, and it is the same answer the cast
# path has always given the same source (resolve_output_format()'s
# `lossless_container` tier). Asking for `br` here would be asking which
# bitrate a lossless stream should have, so the parameter is simply not
# required for it — and it is rejected rather than ignored, since a caller
# that sends one has misunderstood something this route would rather say
# out loud.
#
# It could not have been offered before the `start` seeking arrived: FLAC's
# length is unknowable ahead of the encode, and the byte-offset arithmetic
# that used to do the seeking needed a declared one. Nothing declares a
# length on this path any more, so the objection is gone with it.
LOSSLESS_FORMAT = "flac"

# Only the two forms a browser actually sends: "from here to the end" when
# it resumes or seeks, and an explicit window when it is probing (Safari
# opens with `bytes=0-1`). A multi-range request is answered as if it had
# been a plain GET, which is allowed and which nothing here ever sees.
_RANGE_RE = re.compile(r"^bytes=(\d+)-(\d*)$")

# How long a probe stays usable, and how many are kept. A seek costs a
# second request for the same track seconds after the first, and probing is
# a real ffmpeg invocation — without this, every scrub pays for one.
_PROBE_TTL_SECONDS = 300.0
_PROBE_CACHE_MAX = 256

_probe_cache: dict[tuple[str, str], tuple[float, SourceInfo]] = {}


def reset_probe_cache() -> None:
    """Drop every cached probe (tests)."""
    _probe_cache.clear()


async def _probe_cached(session_id: str, track_id: str, url: str) -> SourceInfo | None:
    """_probe_source(), memoised per (session, track).

    Keyed on the session as well as the track because two sessions can be
    logged into two different media servers, where the same track id means
    two different files. Never keyed on `url` itself — it carries
    credentials for some server types, and it can differ between two calls
    for the same track (Plex resolves it fresh each time)."""
    key = (session_id, track_id)
    now = time.monotonic()
    cached = _probe_cache.get(key)
    if cached is not None and now - cached[0] < _PROBE_TTL_SECONDS:
        return cached[1]

    info = await _probe_source(url)
    if info is None:
        return None
    if len(_probe_cache) >= _PROBE_CACHE_MAX:
        # Plain oldest-first eviction. The access pattern here is "the track
        # playing now, plus whatever was playing recently", so anything
        # cleverer would be measuring the same thing at more cost.
        oldest = min(_probe_cache, key=lambda k: _probe_cache[k][0])
        del _probe_cache[oldest]
    _probe_cache[key] = (now, info)
    return info


def _parse_range(header: str | None, total: int) -> tuple[int, int] | None:
    """(first_byte, last_byte) for a Range header against a `total`-byte
    body, or None when there is nothing to honour.

    A start at or past the end returns None rather than a 416: the length
    here is an estimate (see transcoded_byte_length()), so "past the end"
    can mean the estimate was a few hundred bytes short, not that the
    client asked for something unreasonable. Answering the whole body is
    the harmless reading; refusing would stop playback over rounding."""
    if not header:
        return None
    match = _RANGE_RE.match(header.strip())
    if not match:
        return None
    start = int(match.group(1))
    if start >= total:
        return None
    end = int(match.group(2)) if match.group(2) else total - 1
    return start, min(end, total - 1)


async def _encode(cmd: list[str], byte_limit: int | None):
    """Run ffmpeg and yield its stdout, stopping after `byte_limit` bytes.

    The limit is what makes an explicit Range window (`bytes=0-1`) actually
    end — ffmpeg has no idea the client only asked for the first two bytes
    and would happily encode the whole track into a pipe nobody reads."""
    proc = None
    stderr_task: asyncio.Task | None = None
    produced = 0
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        # Drained concurrently — a full stderr pipe deadlocks the encode,
        # same as in core/streamer.py's stream_tracks().
        stderr_task = asyncio.create_task(proc.stderr.read())

        while True:
            chunk = await proc.stdout.read(8192)
            if not chunk:
                break
            if byte_limit is not None and produced + len(chunk) >= byte_limit:
                yield chunk[: byte_limit - produced]
                produced = byte_limit
                break
            produced += len(chunk)
            yield chunk

        if byte_limit is None or produced < byte_limit:
            await proc.wait()
            stderr = await stderr_task
            if proc.returncode != 0:
                logger.warning(
                    f"[local-stream] ffmpeg exit {proc.returncode}: "
                    f"{stderr.decode(errors='replace')[:400]}"
                )

    except FileNotFoundError:
        logger.error("[local-stream] ❌ ffmpeg not found — please install (apk add ffmpeg)")
        raise

    finally:
        # Covers the client disconnecting mid-track and the byte_limit
        # break above, both of which leave ffmpeg running with nothing
        # reading it.
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        if stderr_task is not None and not stderr_task.done():
            stderr_task.cancel()


@router.get("/stream/local/{track_id}/info")
async def local_stream_info(
    track_id: str,
    session: SessionState = Depends(require_authenticated_session),
):
    """What the source file for `track_id` actually is.

    Exists so the stream-info panel can say the same things about local
    playback that it already says about a cast (see
    components/connect/StreamInfoSection.vue). The frontend knows what it
    *asked* for — that's its own quality setting — but only ffmpeg knows
    what the source is, and the media server's metadata doesn't carry the
    sample rate or bit depth at all.

    Deliberately says nothing about the output: which format is being
    served is the caller's own choice, already in its hands, and answering
    it here would mean two places deciding the same thing. Shares the probe
    cache with the streaming route below, so opening the panel during
    playback costs nothing — the probe has already happened.

    Every field is null when the probe failed. That reads as "unknown" in
    the panel, which is honest; guessing from the file extension would not
    be."""
    try:
        source_url = await asyncio.to_thread(session.media.get_stream_url, track_id)
    except Exception as e:
        logger.warning(f"[local-stream] Could not resolve track {track_id}: {e}")
        return JSONResponse({"error": f"Track not available: {e}"}, status_code=502)

    info = await _probe_cached(session.session_id, track_id, source_url)
    return {
        "source_codec": info.codec if info else None,
        "source_sample_rate": info.sample_rate if info else None,
        "source_bit_depth": info.bit_depth if info else None,
        "source_bitrate_kbps": info.bitrate_kbps if info else None,
    }


@router.get("/stream/local/{track_id}")
async def local_stream(
    track_id: str,
    request: Request,
    fmt: str = Query(description="mp3 | aac | opus | flac"),
    br: int | None = Query(None, description="bitrate in kbps, see ALLOWED_BITRATES; not for flac"),
    start: float | None = Query(
        None, ge=0.0, description="seconds to start from; its presence disables byte ranges"
    ),
    session: SessionState = Depends(require_authenticated_session),
):
    """Transcode one track for this session's own player.

    There is no "original" passthrough here on purpose: a listener who
    wants the untouched file gets the ordinary /rest/stream.view URL from
    the frontend instead, so that path keeps behaving exactly as it always
    has rather than gaining a second implementation that has to be kept
    identical to the first. `fmt=flac` is not that passthrough either — it
    is a real re-encode, for the one case where "untouched" and "audible"
    cannot both be had (see LOSSLESS_FORMAT).

    Two ways to start somewhere other than the beginning, and they are
    mutually exclusive:

    - `start`, in seconds. The caller says where it wants to be, and gets a
      stream that begins there and carries no length at all. Nothing has to
      agree about how bytes map onto time, which is what makes this the
      only one of the two that works for a format whose encoder does not
      produce exactly `br` kbps.
    - A `Range` header, in bytes, against the declared `bitrate x duration`
      length. This is the browser seeking by itself, and it only lands
      correctly while the encoder really does hit `br` — see
      ALLOWED_BITRATES above for why that means mp3.

    `start` takes precedence, and its *presence* is what counts rather than
    its value: `start=0` is a caller saying "I am doing the seeking, and I
    happen to want the beginning", which still means no length. Declaring
    one anyway would invite the media element to seek against it behind
    that caller's back, which is exactly what the caller took over to
    avoid."""
    lossless = fmt == LOSSLESS_FORMAT
    allowed = ALLOWED_BITRATES.get(fmt)
    if allowed is None and not lossless:
        expected = sorted([*ALLOWED_BITRATES, LOSSLESS_FORMAT])
        return JSONResponse(
            {"error": f"Unsupported format '{fmt}' — expected one of {expected}"},
            status_code=400,
        )
    if lossless and br is not None:
        return JSONResponse(
            {"error": f"{LOSSLESS_FORMAT} carries no bitrate — drop the br parameter"},
            status_code=400,
        )
    if not lossless and br not in allowed:
        return JSONResponse(
            {"error": f"Unsupported bitrate {br} for {fmt} — expected one of {sorted(allowed)}"},
            status_code=400,
        )

    # to_thread: instant for Subsonic/Jellyfin, a real network lookup for
    # Plex — same reasoning as routes/playback.py's own call.
    try:
        source_url = await asyncio.to_thread(session.media.get_stream_url, track_id)
    except Exception as e:
        logger.warning(f"[local-stream] Could not resolve track {track_id}: {e}")
        return JSONResponse({"error": f"Track not available: {e}"}, status_code=502)

    info = await _probe_cached(session.session_id, track_id, source_url)
    # No sample rate is passed to the lossless branch, and none is wanted:
    # resampling is a device's limit to impose (see lossless_encode_args()),
    # and the browser this is for has none — it is being handed the source
    # rate exactly as it came. DSD is the one exception, and not a device
    # limit either: its decoded rate is an artefact of the format that no
    # browser decodes (see dsd_resample_args()).
    args, content_type = (
        lossless_encode_args(dsd_resample_args(info))
        if lossless
        else lossy_encode_args(fmt, br, info.sample_rate if info else None)
    )

    headers = {"Cache-Control": "no-store"}
    status_code = 200
    byte_limit: int | None = None
    start_seconds = start or 0.0

    # No duration means no length and therefore no seeking — the track still
    # plays, the scrub bar just can't move. Rare enough to accept (it needs
    # the probe to have failed outright, or a source ffmpeg reports no
    # Duration line for) and far better than refusing to play at all.
    #
    # A caller that passed `start` at all lands here too, deliberately: it
    # is asking for a plain stream from a point in time, and the whole
    # length/Range apparatus below would only get in its way.
    #
    # And mp3 only, because that is the whole of what the arithmetic here
    # is true for: a declared length of `bitrate x duration` and a byte
    # offset divided back into a second both assume an encoder that really
    # produces that many bytes per second, which LAME's padded CBR does and
    # neither of the others comes close to (see ALLOWED_BITRATES above, and
    # lossy_encode_args()'s own measurements for opus). Answering an aac or
    # opus request the same way declared a length that is wrong by whole
    # percent and invited the element to seek against it — nothing here
    # asks for one (the app always sends `start`), and a caller that does
    # gets a plain stream rather than a plausible-looking lie.
    if start is None and fmt == "mp3" and info is not None and info.duration:
        total = transcoded_byte_length(br, info.duration)
        headers["Accept-Ranges"] = "bytes"
        rng = _parse_range(request.headers.get("range"), total)
        if rng is None:
            headers["Content-Length"] = str(total)
            # Capped at exactly what was declared. ffmpeg overshoots the
            # estimate by a few hundred bytes — an ID3 header plus the
            # encoder's own padding on the final frame (measured: +906
            # bytes on a 180s 192k encode, +862 with the tag suppressed) —
            # and a body longer than its Content-Length is a protocol
            # violation, not a rounding detail. The cost is the last ~0.04s
            # of the track; the alternative is declaring a length nothing
            # can rely on, which is what the seeking here is built on.
            byte_limit = total
        else:
            start, end = rng
            # The same division in both directions, so the position the
            # browser scrubbed to and the second ffmpeg is given agree even
            # where the length estimate itself is slightly off.
            start_seconds = start / (br * 1000 / 8)
            byte_limit = end - start + 1
            status_code = 206
            headers["Content-Range"] = f"bytes {start}-{end}/{total}"
            headers["Content-Length"] = str(byte_limit)

    cmd = [FFMPEG_BIN, "-hide_banner", "-loglevel", "warning"]
    # Lets a dropped connection to the media server be picked back up
    # inside ffmpeg rather than ending the encode — see
    # http_reconnect_args(). It matters more here than on the cast path,
    # because a track start is the one moment the browser has no buffer to
    # hide anything behind: everything after it is playing out of several
    # minutes of already-fetched audio (measured: Chromium holds around
    # 9.5 MiB of a length-less stream, seven minutes at 128k), while the
    # first second of a new track is playing out of nothing.
    cmd += http_reconnect_args(source_url)
    if start_seconds > 0:
        # Before -i, for input-side seeking — same as stream_tracks()'s
        # start_offset handling.
        cmd += ["-ss", f"{start_seconds:.3f}"]
    cmd += ["-i", source_url, "-vn", *args, "pipe:1"]

    # info, not debug: this is the one line that says a transcode is
    # happening at all. Casting has had an equivalent since the copy tiers
    # were added (resolve_output_format()'s "[ffmpeg] format probe: ..."),
    # and without one here the feature is invisible in the log — which is
    # indistinguishable from it not running.
    logger.info(
        f"[local-stream] {track_id}: "
        f"{info.codec if info else 'unknown'} → {fmt}{'' if lossless else f' {br}k'}"
        f"{f', from {start_seconds:.1f}s' if start_seconds else ''}"
    )
    return StreamingResponse(
        _encode(cmd, byte_limit),
        status_code=status_code,
        media_type=content_type,
        headers=headers,
    )
