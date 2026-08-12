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

import array
import asyncio
import logging

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

    Uses array.array (C-speed bulk conversion) and the max()/min() builtins
    over array slices (also C-speed) rather than a manual per-sample Python
    loop — a multi-minute track at _SAMPLE_RATE is a few million samples,
    and looping over that at the Python level would be exactly the kind of
    synchronous, un-awaited CPU work that turned out to starve the event
    loop in audio_analysis.py's FFT path (see its _MAX_LOOKAHEAD_SECONDS).
    Still run via asyncio.to_thread() by the caller out of caution."""
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    n = len(samples)
    if n == 0:
        return [0.0] * _PEAK_COUNT

    bucket_size = max(1, n // _PEAK_COUNT)
    peaks = []
    for b in range(_PEAK_COUNT):
        start = b * bucket_size
        end = n if b == _PEAK_COUNT - 1 else min(n, start + bucket_size)
        if start >= end:
            peaks.append(0.0)
            continue
        chunk = samples[start:end]
        peak = max(max(chunk), -min(chunk))
        peaks.append(peak / 32768.0)

    loudest = max(peaks, default=0.0)
    if loudest > 1e-6:
        peaks = [min(1.0, p / loudest) for p in peaks]
    return peaks


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
    except asyncio.TimeoutError:
        logger.warning(f"[waveform] Decode timed out for {track_id}")
        proc.kill()
        return []

    if proc.returncode != 0:
        logger.warning(
            f"[waveform] ffmpeg failed for {track_id}: "
            f"{stderr.decode(errors='replace')[:200]}"
        )
        return []

    peaks = await asyncio.to_thread(_compute_peaks, stdout)
    logger.info(
        f"[waveform] Computed {len(peaks)} peaks for {track_id} "
        f"({len(stdout)} PCM bytes)"
    )
    return peaks
