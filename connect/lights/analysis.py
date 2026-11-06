"""lights/analysis.py — what the lights need to know about a song.

The whole song is decoded once when it starts (1-2 s for a pop song,
measured 2026-11-01) rather than analysed live: the beats are then known
*before* they are heard, which is what lets a colour leave early enough to
land on one.

Three things come out of it: the beats (beats.py), how strongly each of
them is actually heard, and a slow loudness curve, so a quiet verse and a
full chorus do not light the room the same. A beat is placed where the
tempo says one belongs even through a breakdown; its own strength is what
lets the lights go quiet with the drums.
"""

from __future__ import annotations

import asyncio
import colorsys
import io
import logging
import math
import time
from collections import OrderedDict
from dataclasses import dataclass

import httpx
import numpy as np

from core.beat_analysis import (
    ANALYSIS_RATE,
    beat_strengths,
    onset_envelopes,
)
from core.streamer import pcm_decode_cmd
from lights.beats import Beats, find_beats, punch_envelope, snap_envelope

logger = logging.getLogger("connect.lights")

# Values per second of the loudness curve.
ENERGY_RATE = 4
# Averaged over this long, so the curve follows sections, not single hits.
_ENERGY_WINDOW_SECONDS = 2.0
_DECODE_TIMEOUT_SECONDS = 60.0
# Only this much of a song is decoded: a one-hour DJ mix in full would be
# about 240 MB of samples in memory. Past it the beats run on at the tempo
# found and the loudness stays at its last value.
MAX_ANALYSED_SECONDS = 20 * 60
# Songs kept analysed: the current one and a few back, for a skip back.
_CACHE_SIZE = 6
# A decode that came back empty is tried again this often, this long apart:
# usually the media server was briefly away, sometimes the file is broken.
_DECODE_ATTEMPTS = 3
_DECODE_RETRY_SECONDS = 30.0
RGB = tuple[float, float, float]

# How strongly a beat is heard, against the song's strong beats (their 90th
# percentile, since a kick may play on only every other beat). A kick is a
# full flash from _KICK_FULL on and none below _KICK_FROM. A snare or clap
# without a kick flashes too, up to _SNAP_HIT: still a hit, not the hit.
_KICK_FROM = 0.15
_KICK_FULL = 0.6
_SNAP_FROM = 0.3
_SNAP_FULL = 0.8
_SNAP_HIT = 0.6
# A beat at least this strong counts as one for the colour steps.
HEARD = 0.5


@dataclass(frozen=True)
class SongLights:
    duration: float
    # None where the song has no beat worth following (a ballad without
    # drums, spoken word): the lights then only follow the loudness.
    beats: Beats | None
    # 0..1, ENERGY_RATE values a second; 1 is the song's own loud part.
    energy: np.ndarray
    # 0..1 per beat of `beats`: how strongly it is heard. None for every
    # beat a full one.
    hits: np.ndarray | None = None

    def energy_at(self, t: float) -> float:
        if len(self.energy) == 0:
            return 0.5
        i = int(max(0.0, t) * ENERGY_RATE)
        return float(self.energy[min(i, len(self.energy) - 1)])

    def beat_at(self, t: float) -> tuple[int, float] | None:
        """(the number of the last beat by `t`, seconds since it), or None
        without beats. Before the first beat and after the last the count
        runs on at the song's tempo."""
        beats = self.beats
        if beats is None:
            return None
        times = beats.times
        if t < times[0]:
            i = math.floor((t - times[0]) / beats.period)
            return i, t - (times[0] + i * beats.period)
        if t >= times[-1]:
            i = math.floor((t - times[-1]) / beats.period)
            return len(times) - 1 + i, t - (times[-1] + i * beats.period)
        i = int(np.searchsorted(times, t, side="right")) - 1
        return i, t - float(times[i])

    def is_downbeat(self, beat_index: int) -> bool:
        return self.beats is not None and (beat_index - self.beats.downbeat) % 4 == 0

    def hit(self, beat_index: int) -> float:
        """Past the analysed part (MAX_ANALYSED_SECONDS) a full beat, as
        it was before the beats were weighed at all."""
        if self.hits is None or not 0 <= beat_index < len(self.hits):
            return 1.0
        return float(self.hits[beat_index])

    def heard_beats(self, beat_index: int) -> int:
        """How many beats up to `beat_index` were heard as one: a count
        that stands still through a breakdown."""
        if self.hits is None or beat_index < 0:
            return beat_index
        heard = int(np.count_nonzero(self.hits[: beat_index + 1] >= HEARD))
        return heard + max(0, beat_index + 1 - len(self.hits))


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


def _ramp(value: np.ndarray, low: float, high: float) -> np.ndarray:
    return np.clip((value - low) / (high - low), 0.0, 1.0)


def _against_strong_beats(strength: np.ndarray) -> np.ndarray:
    strong = float(np.percentile(strength, 90))
    return strength / strong if strong > 0 else np.zeros_like(strength)


def beat_hits(punch: np.ndarray, snap: np.ndarray, beats: Beats) -> np.ndarray:
    """How strongly each of `beats` is heard: by its kick, or more faintly
    by its snare or clap. Bass notes and pads between the drums stay dark -
    a note only counts as far as it is as loud as the song's kick."""
    kick = _against_strong_beats(beat_strengths(punch, beats.times))
    crack = _against_strong_beats(beat_strengths(snap, beats.times))
    hits = np.maximum(
        _ramp(kick, _KICK_FROM, _KICK_FULL), _SNAP_HIT * _ramp(crack, _SNAP_FROM, _SNAP_FULL)
    )
    return hits.astype(np.float32)


def analyse_samples_for_lights(samples: np.ndarray) -> SongLights:
    full, kick = onset_envelopes(samples)
    beats = None
    hits = None
    if len(full):
        punch = punch_envelope(samples, len(full))
        beats = find_beats(full, kick, punch)
        if beats:
            hits = beat_hits(punch, snap_envelope(samples, len(full)), beats)
    return SongLights(
        duration=len(samples) / ANALYSIS_RATE,
        beats=beats,
        energy=energy_curve(samples),
        hits=hits,
    )


async def _decode(url: str) -> np.ndarray | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            *pcm_decode_cmd(url, 0.0, MAX_ANALYSED_SECONDS, channels=1, rate=ANALYSIS_RATE),
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
# A colour this close to grey is not one: brightened to full value, the
# faint tint of a white cover would light the room white. The same line the
# visualizer bars draw before falling back to the theme's accent.
_MIN_SATURATION = 0.2
PALETTE_SIZE = 3


# The app's accent on Now Playing (services/colorExtractor.ts's colour put
# through services/visualizerColor.ts), mirrored so "theme" lights the room
# in the colour the app shows: below these it keeps the theme's accent,
# above them the colour is lifted to the bars' saturation and lightness.
_ACCENT_MIN_SATURATION = 0.2
_ACCENT_MIN_LIGHTNESS = 0.25
_ACCENT_SATURATION = 0.65
_ACCENT_LIGHTNESS = (0.55, 0.72)


@dataclass(frozen=True)
class PictureColours:
    """A picture's colours as the lights take them: `palette` for "palette"
    and "rotate", `accent` for "theme" - None where the app keeps the
    theme's own accent for it."""

    palette: tuple[RGB, ...] = ()
    accent: RGB | None = None


NO_COLOURS = PictureColours()


def picture_colours(image: bytes) -> PictureColours:
    from PIL import Image

    with Image.open(io.BytesIO(image)) as img:
        small = np.asarray(img.convert("RGBA").resize((32, 32))).reshape(-1, 4) / 255.0
    return PictureColours(_palette(small[:, :3]), _accent(small))


def _accent(rgba: np.ndarray) -> RGB | None:
    """The app's accent for the picture at full value, or None for the
    theme's: a weighted average leaning on saturated mid-tones, dropped
    when it comes out grey or dark."""
    rgb = rgba[rgba[:, 3] >= 128 / 255, :3]
    top = rgb.max(axis=1)
    low = rgb.min(axis=1)
    lightness = (top + low) / 2
    saturation = (top - low) / np.maximum(1 - np.abs(top + low - 1), 1e-6)
    weight = np.maximum(saturation**2 * (1 - np.abs(lightness - 0.5) * 1.4), 0)
    if weight.sum() <= 0:
        return None
    mean = np.round((rgb * weight[:, None]).sum(axis=0) / weight.sum() * 255) / 255
    h, l, s = colorsys.rgb_to_hls(*mean)
    if s < _ACCENT_MIN_SATURATION or l < _ACCENT_MIN_LIGHTNESS:
        return None
    lo, hi = _ACCENT_LIGHTNESS
    colour = colorsys.hls_to_rgb(h, min(max(l, lo), hi), max(s, _ACCENT_SATURATION))
    peak = max(colour)
    return (colour[0] / peak, colour[1] / peak, colour[2] / peak)


def _palette(small: np.ndarray, size: int = PALETTE_SIZE) -> tuple[RGB, ...]:
    """The picture's most present colours, the strongest first, each
    brightened to full value - the lights carry brightness separately, so
    only the hue matters. Fewer than `size` when it has fewer clearly
    different colours; none for one without colour, black-and-white or
    nearly white."""
    top = small.max(axis=1)
    low = small.min(axis=1)
    saturation = np.where(top > 0, (top - low) / np.maximum(top, 1e-6), 0)
    # Grey, black and white pixels say nothing about the cover's colour.
    weight = saturation**2 * (top > 0.15)
    if weight.sum() < 1e-3:
        return ()

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
        if 1 - colour.min() < _MIN_SATURATION:
            continue
        # Measured on the bucket's own mean colour, not the bucket number:
        # neighbouring buckets can hold hues further apart than their
        # neighbours on the far side, and the wheel wraps at red.
        h = float(_hue(colour[None, :], colour.max(keepdims=True), colour.min(keepdims=True))[0])
        if all(min(abs(h - o), 1 - abs(h - o)) >= _MIN_HUE_GAP for o in hues):
            colours.append((float(colour[0]), float(colour[1]), float(colour[2])))
            hues.append(h)
    return tuple(colours)


def _hue(rgb: np.ndarray, top: np.ndarray, low: np.ndarray) -> np.ndarray:
    """Hue per pixel, 0..1."""
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    span = np.maximum(top - low, 1e-6)
    h = np.where(
        top == r, ((g - b) / span) % 6, np.where(top == g, (b - r) / span + 2, (r - g) / span + 4)
    )
    return (h / 6.0) % 1.0


async def cover_colours(url: str | None) -> PictureColours | None:
    """No colours for a song without a cover or with one that is no image;
    None when the cover could not be fetched, worth another try."""
    if not url:
        return NO_COLOURS
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as http:
            reply = await http.get(url)
            reply.raise_for_status()
    except Exception as e:
        logger.debug(f"[lights] Could not fetch the cover: {e}")
        return None
    try:
        return await asyncio.to_thread(picture_colours, reply.content)
    except Exception as e:
        logger.debug(f"[lights] No cover colours: {e}")
        return NO_COLOURS


async def fanart_colours(url: str) -> PictureColours | None:
    """The colours of a Fanart.tv artist background, from connect's own
    image store (fetched into it if this is the first ask). None when the
    image cannot be had - the cover's colours then stay."""
    from core import fanart

    try:
        data = fanart.get_cached_image(url)
        if data is None:
            fetched = await fanart.fetch_image(url)
            if fetched is None:
                return None
            data = fetched[0]
            fanart.store_image(url, data)
        return await asyncio.to_thread(picture_colours, data)
    except Exception as e:
        logger.debug(f"[lights] No artist picture colours: {e}")
        return None


class AnalysisCache:
    """Song id -> SongLights, with one analysis in flight per song."""

    def __init__(self) -> None:
        self._done: OrderedDict[str, SongLights | None] = OrderedDict()
        self._running: dict[str, asyncio.Task] = {}
        # Song id -> (failed decodes, when the last one failed).
        self._failed: dict[str, tuple[int, float]] = {}

    def get(self, song_id: str) -> SongLights | None:
        return self._done.get(song_id)

    def has(self, song_id: str) -> bool:
        return song_id in self._done

    def request(self, song_id: str, url: str) -> None:
        if song_id in self._running or self._done.get(song_id) is not None:
            return
        if song_id in self._done:
            attempts, at = self._failed.get(song_id, (_DECODE_ATTEMPTS, 0.0))
            if attempts >= _DECODE_ATTEMPTS or time.monotonic() - at < _DECODE_RETRY_SECONDS:
                return
        self._running[song_id] = asyncio.create_task(self._run(song_id, url))

    async def _run(self, song_id: str, url: str) -> None:
        attempts = self._failed.get(song_id, (0, 0.0))[0]
        try:
            samples = await _decode(url)
            if samples is None:
                result = None
                attempts += 1
            else:
                result = await asyncio.to_thread(analyse_samples_for_lights, samples)
        except Exception as e:
            # The analysis itself failing will fail the same way again.
            logger.warning(f"[lights] Analysing {song_id} failed: {e}")
            result = None
            attempts = _DECODE_ATTEMPTS
        finally:
            self._running.pop(song_id, None)
        # A failed song is remembered too, so it is not decoded again on
        # every tick - the lights follow nothing but the colour until the
        # next attempt, if there is one.
        self._done[song_id] = result
        if result is None:
            self._failed[song_id] = (attempts, time.monotonic())
        else:
            self._failed.pop(song_id, None)
        while len(self._done) > _CACHE_SIZE:
            gone, _ = self._done.popitem(last=False)
            self._failed.pop(gone, None)
        if result is not None:
            bpm = f"{result.beats.bpm:.1f} BPM" if result.beats else "no steady beat"
            logger.debug(f"[lights] Analysed {song_id}: {bpm}")

    def cancel_all(self) -> None:
        for task in self._running.values():
            task.cancel()
        self._running.clear()
