"""core/waveform.py — Per-track amplitude waveform, computed on demand.

Unlike core/audio_analysis.py (a live FFT feed tied to one currently-casting
stream), this is a one-shot job: decode a whole track to PCM and bucket it
into a small number of peak-amplitude values for the player's waveform seek
bar (TrackWaveform.vue). Computed fresh on every call — decode itself is
fast (well under a second once the audio bytes arrive), and on a typical
self-hosted setup the network fetch from the media server is too, so
persisting results to disk traded a marginal win on replay for an
unbounded, never-cleaned-up cache directory. The frontend's own in-memory
cache (services/connect/waveform.ts) already avoids re-fetching while
browsing within one session, which is the case that actually matters.
"""

import asyncio
import logging

import numpy as np

logger = logging.getLogger("connect.waveform")

# Mono, low rate — only the amplitude envelope is needed here, not frequency
# detail, so this can be far cheaper than audio_analysis.py's decode.
_SAMPLE_RATE = 11025
_DECODE_CMD = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "{url}",
    "-vn",
    "-ac",
    "1",
    "-ar",
    str(_SAMPLE_RATE),
    "-f",
    "s16le",
    "pipe:1",
]
# Bucket count returned to the frontend — fixed rather than parameterized by
# canvas width; plenty of resolution for the player bar's actual on-screen
# size.
_PEAK_COUNT = 300
# Guards against a stalled/broken source stream hanging the request forever
# — a one-shot decode has no other pacing to fall back on (contrast with
# audio_analysis.py, which is paced by real playback throughout).
_DECODE_TIMEOUT_SECONDS = 60.0


def _compute_peaks(pcm: bytes) -> list[float]:
    """16-bit little-endian mono PCM -> _PEAK_COUNT peak-amplitude values in
    [0, 1], normalized against this track's own loudest bucket (not a fixed
    theoretical max) so quiet tracks still use the full visual height.

    Vectorized with numpy, and that matters more than it looks. The previous
    version used array.array plus the max()/min() builtins over slices,
    believing those to be "C-speed bulk" operations. They are not, in the
    way that counts: both iterate via the iterator protocol, boxing every
    single sample into a Python int and doing a rich comparison on it. At
    _SAMPLE_RATE mono that is ~11k allocations per second of audio, twice
    over (max and min) — fine for a 3-minute song, ruinous for a long DJ
    mix. Measured live on beacon-dev 2026-08-22: an 80-minute mix
    (52.8M samples) blocked the event loop for 2.53s, during which the
    casting device's open /stream socket received nothing at all.

    asyncio.to_thread() in the caller did not, and could not, prevent that:
    boxing ints and comparing them holds the GIL for the entire duration,
    so the "background" thread stalls the event loop just as thoroughly as
    inline code would. Only work that actually drops the GIL — or, as here,
    that finishes in milliseconds instead of seconds because it runs as
    vectorized C over raw memory — makes that hop meaningful."""
    usable = len(pcm) - (len(pcm) % 2)
    # memoryview, not pcm[:usable]: slicing the bytes object would copy the
    # whole decoded track (~105MB for the mix above) just to drop a
    # trailing odd byte.
    samples = np.frombuffer(memoryview(pcm)[:usable], dtype="<i2")
    n = samples.size
    if n == 0:
        return [0.0] * _PEAK_COUNT

    if n < _PEAK_COUNT:
        # Fewer samples than buckets — one sample each, rest stay silent,
        # matching what the slice-based version produced here.
        peaks = np.zeros(_PEAK_COUNT, dtype=np.float64)
        peaks[:n] = np.abs(samples.astype(np.int32)) / 32768.0
    else:
        bucket_size = n // _PEAK_COUNT
        whole = bucket_size * _PEAK_COUNT
        buckets = samples[:whole].reshape(_PEAK_COUNT, bucket_size)
        # Reduce in int16 (values are in range), then widen before negating:
        # -(-32768) does not fit in an int16 and would wrap to itself.
        highs = buckets.max(axis=1).astype(np.int32)
        lows = buckets.min(axis=1).astype(np.int32)
        peaks = np.maximum(highs, -lows) / 32768.0
        # Whatever didn't divide evenly belongs to the final bucket, same as
        # the slice-based version's `end = n` on the last iteration.
        tail = samples[whole:]
        if tail.size:
            tail_peak = max(int(tail.max()), -int(tail.min())) / 32768.0
            peaks[-1] = max(float(peaks[-1]), tail_peak)

    loudest = float(peaks.max())
    if loudest > 1e-6:
        peaks = np.minimum(1.0, peaks / loudest)
    return peaks.tolist()


async def get_waveform(track_id: str, url: str) -> list[float]:
    """Peak-amplitude lookup for one track, decoded fresh every call. `url`
    should be session.media.get_stream_url(track_id) — a pure string
    builder, no network call of its own, so callers don't need get_track()
    first."""
    cmd = [arg if arg != "{url}" else url for arg in _DECODE_CMD]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        logger.warning("[waveform] ffmpeg not found — waveform disabled")
        return []

    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=_DECODE_TIMEOUT_SECONDS
        )
    except TimeoutError:
        logger.warning(f"[waveform] Decode timed out for {track_id}")
        proc.kill()
        # communicate()'s own reader tasks were cancelled mid-read by the
        # timeout above — without this, the process can linger as a zombie
        # and its stdout/stderr pipes stay open until GC'd, since nothing
        # else drains or reaps it. Bounded wait: kill() should make this
        # resolve almost immediately, but this must never itself hang the
        # request if it somehow doesn't.
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except TimeoutError:
            logger.warning(f"[waveform] Process for {track_id} didn't exit after kill()")
        return []

    if proc.returncode != 0:
        logger.warning(
            f"[waveform] ffmpeg failed for {track_id}: "
            f"{stderr.decode(errors='replace')[:200]}"
        )
        return []

    peaks = await asyncio.to_thread(_compute_peaks, stdout)
    logger.debug(
        f"[waveform] Computed {len(peaks)} peaks for {track_id} "
        f"({len(stdout)} PCM bytes)"
    )
    return peaks
