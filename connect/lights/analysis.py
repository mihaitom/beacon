"""lights/analysis.py — what the lights need to know about a song.

The whole song is decoded once when it starts (1-2 s for a pop song,
measured 2026-11-01) rather than analysed live: the beat grid then says
where every beat falls *before* it is heard, which is what lets a colour
leave early enough to land on it.

Two things come out of it: the beat grid (core/beat_analysis.py, the same
one beatmixing uses) and a slow loudness curve, so a quiet verse and a
full chorus do not light the room the same.
"""

from __future__ import annotations

import asyncio
import io
import logging
from collections import OrderedDict
from dataclasses import dataclass

import httpx
import numpy as np

from core.beat_analysis import ANALYSIS_RATE, BeatGrid, analyse_samples
from core.streamer import pcm_decode_cmd
from core.transition_planner import MIN_CONFIDENCE

logger = logging.getLogger("connect.lights")

# Values per second of the loudness curve.
ENERGY_RATE = 4
# Averaged over this long, so the curve follows sections, not single hits.
_ENERGY_WINDOW_SECONDS = 2.0
_DECODE_TIMEOUT_SECONDS = 60.0
# Songs kept analysed: the current one and a few back, for a skip back.
_CACHE_SIZE = 6
RGB = tuple[float, float, float]

# Fallback when a cover has no usable colour: a warm white.
DEFAULT_COLOUR: RGB = (1.0, 0.62, 0.32)


@dataclass(frozen=True)
class SongLights:
    duration: float
    # None where the song has no beat worth following (a ballad without
    # drums, spoken word): the lights then only follow the loudness.
    grid: BeatGrid | None
    # 0..1, ENERGY_RATE values a second; 1 is the song's own loud part.
    energy: np.ndarray

    def energy_at(self, t: float) -> float:
        if len(self.energy) == 0:
            return 0.5
        i = int(max(0.0, t) * ENERGY_RATE)
        return float(self.energy[min(i, len(self.energy) - 1)])


def energy_curve(samples: np.ndarray, rate: int = ANALYSIS_RATE) -> np.ndarray:
    hop = rate // ENERGY_RATE
    n = len(samples) // hop
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    rms = np.sqrt(np.mean(samples[: n * hop].reshape(n, hop) ** 2, axis=1))
    width = max(1, int(_ENERGY_WINDOW_SECONDS * ENERGY_RATE))
    smooth = np.convolve(rms, np.ones(width) / width, mode="same")
    # Against the song's own loud part, not full scale: a quietly mastered
    # song should still reach full brightness in its chorus.
    top = float(np.percentile(smooth, 95)) if np.any(smooth > 0) else 0.0
    if top <= 0:
        return np.zeros(n, dtype=np.float32)
    return np.clip(smooth / top, 0.0, 1.0).astype(np.float32)


def analyse_samples_for_lights(samples: np.ndarray) -> SongLights:
    region = analyse_samples(samples, 0.0)
    grid = region.grid
    if grid is not None and grid.confidence < MIN_CONFIDENCE:
        grid = None
    return SongLights(
        duration=len(samples) / ANALYSIS_RATE, grid=grid, energy=energy_curve(samples)
    )


async def _decode(url: str) -> np.ndarray | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            *pcm_decode_cmd(url, 0.0, None, channels=1, rate=ANALYSIS_RATE),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            data, _ = await asyncio.wait_for(proc.communicate(), _DECODE_TIMEOUT_SECONDS)
        finally:
            if proc.returncode is None:
                proc.kill()
    except (OSError, TimeoutError) as e:
        logger.info(f"[lights] Decoding for the lights failed: {e}")
        return None
    if not data:
        return None
    return np.frombuffer(data[: len(data) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0


# Hue buckets a cover's colours are sorted into, and how far apart two of
# them have to be (as a fraction of the colour wheel, 50 degrees) to count
# as different colours rather than shades of one.
_HUE_BUCKETS = 12
_MIN_HUE_GAP = 50 / 360
# A bucket with less than this share of the strongest one's weight is a
# detail of the cover, not one of its colours.
_MIN_SHARE = 0.08
PALETTE_SIZE = 3


def cover_palette(image: bytes, size: int = PALETTE_SIZE) -> tuple[RGB, ...]:
    """The cover's most present colours, the strongest first, each
    brightened to full value - the lights carry brightness separately, so
    only the hue matters. Fewer than `size` when the cover has fewer
    clearly different colours; DEFAULT_COLOUR alone for a grey one."""
    from PIL import Image

    with Image.open(io.BytesIO(image)) as img:
        small = np.asarray(img.convert("RGB").resize((32, 32))).reshape(-1, 3) / 255.0
    top = small.max(axis=1)
    low = small.min(axis=1)
    saturation = np.where(top > 0, (top - low) / np.maximum(top, 1e-6), 0)
    # Grey, black and white pixels say nothing about the cover's colour.
    weight = saturation**2 * (top > 0.15)
    if weight.sum() < 1e-3:
        return (DEFAULT_COLOUR,)

    hue = _hue(small, top, low)
    bucket = np.minimum((hue * _HUE_BUCKETS).astype(int), _HUE_BUCKETS - 1)
    per_bucket = np.bincount(bucket, weights=weight, minlength=_HUE_BUCKETS)
    colours: list[RGB] = []
    hues: list[float] = []
    for b in np.argsort(per_bucket)[::-1]:
        if len(colours) == size or per_bucket[b] < per_bucket.max() * _MIN_SHARE:
            break
        w = weight * (bucket == b)
        rgb = (small * w[:, None]).sum(axis=0) / w.sum()
        peak = rgb.max()
        if peak <= 0:
            continue
        colour = rgb / peak
        # Measured on the bucket's own mean colour, not the bucket number:
        # neighbouring buckets can hold hues further apart than their
        # neighbours on the far side, and the wheel wraps at red.
        h = float(_hue(colour[None, :], colour.max(keepdims=True), colour.min(keepdims=True))[0])
        if all(min(abs(h - o), 1 - abs(h - o)) >= _MIN_HUE_GAP for o in hues):
            colours.append((float(colour[0]), float(colour[1]), float(colour[2])))
            hues.append(h)
    return tuple(colours) or (DEFAULT_COLOUR,)


def _hue(rgb: np.ndarray, top: np.ndarray, low: np.ndarray) -> np.ndarray:
    """Hue per pixel, 0..1."""
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    span = np.maximum(top - low, 1e-6)
    h = np.where(
        top == r, ((g - b) / span) % 6, np.where(top == g, (b - r) / span + 2, (r - g) / span + 4)
    )
    return (h / 6.0) % 1.0


async def cover_colours(url: str | None) -> tuple[RGB, ...]:
    if not url:
        return (DEFAULT_COLOUR,)
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as http:
            reply = await http.get(url)
            reply.raise_for_status()
        return await asyncio.to_thread(cover_palette, reply.content)
    except Exception as e:
        logger.debug(f"[lights] No cover colours: {e}")
        return (DEFAULT_COLOUR,)


class AnalysisCache:
    """Song id -> SongLights, with one analysis in flight per song."""

    def __init__(self) -> None:
        self._done: OrderedDict[str, SongLights | None] = OrderedDict()
        self._running: dict[str, asyncio.Task] = {}

    def get(self, song_id: str) -> SongLights | None:
        return self._done.get(song_id)

    def has(self, song_id: str) -> bool:
        return song_id in self._done

    def request(self, song_id: str, url: str) -> None:
        if song_id in self._done or song_id in self._running:
            return
        self._running[song_id] = asyncio.create_task(self._run(song_id, url))

    async def _run(self, song_id: str, url: str) -> None:
        try:
            samples = await _decode(url)
            result = (
                None
                if samples is None
                else await asyncio.to_thread(analyse_samples_for_lights, samples)
            )
        except Exception as e:
            logger.warning(f"[lights] Analysing {song_id} failed: {e}")
            result = None
        finally:
            self._running.pop(song_id, None)
        # A failed song is remembered too, so it is not decoded again on
        # every tick - the lights just follow nothing but the colour.
        self._done[song_id] = result
        while len(self._done) > _CACHE_SIZE:
            self._done.popitem(last=False)
        if result is not None:
            bpm = f"{result.grid.bpm:.1f} BPM" if result.grid else "no steady beat"
            logger.debug(f"[lights] Analysed {song_id}: {bpm}")

    def cancel_all(self) -> None:
        for task in self._running.values():
            task.cancel()
        self._running.clear()
