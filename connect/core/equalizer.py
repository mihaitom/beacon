"""core/equalizer.py — a speaker's equalizer curve, as ffmpeg filters or live.

The curve is the listener's (stores/equalizer.ts in the renderer): a list of
bands, each a centre frequency, a gain and a Q - peaking for the ten-band
curve, and low or high shelves as well for an imported headphone profile.
Every one is an RBJ cookbook biquad, which is what the renderer plays for
this device's own playback and what ffmpeg's `equalizer`, `lowshelf` and
`highshelf` filters are - so a curve sounds the same in the app and on a
speaker. The bands travel as numbers rather than being defined twice.

Curves are kept per speaker, keyed `type:name` like the device volumes
(SessionState.device_volumes), because the point is mostly the speaker: a
kitchen box without bass should not hand its bass boost to the living room.

A single song's stream takes the curve as ffmpeg filters, fixed for that
song. The mix (transitions on) runs one encoder for as long as the mix
lasts, so there LiveEqualizer filters the PCM on its way in, and a changed
curve is heard without restarting anything.
"""

import functools
import math
from typing import Any

import numpy as np

from .mix_dsp import Dither, pcm_to_float, soft_limit
from .mix_timeline import SAMPLE_RATE

# What one band may ask for. The ten bands go to ±12 dB, an imported profile
# can ask for more; the bounds here only keep a hand-made request from
# reaching ffmpeg as nonsense.
MAX_GAIN_DB = 20.0
MIN_FREQUENCY_HZ = 20.0
MAX_FREQUENCY_HZ = 20000.0
MIN_Q = 0.1
MAX_Q = 10.0
# A measurement program's filter set, 20 per channel at most.
MAX_BANDS = 20

PEAKING = "peaking"
# ffmpeg's filter for each type - also the names the renderer sends.
_FFMPEG_FILTERS = {PEAKING: "equalizer", "lowshelf": "lowshelf", "highshelf": "highshelf"}

# The rate the headroom is worked out at. The response of a biquad shifts a
# little with the sample rate near Nyquist; 48 kHz is what the renderer's
# AudioContext usually runs at, and the peak this finds sits well below
# that region for any curve the dialog can make.
_RESPONSE_RATE = 48000
# Enough points that two adjacent boosted bands' combined peak, which lies
# between their centres, is not missed: 1/40 octave at 400 points.
_RESPONSE_POINTS = 400

# frequency, gain and q as floats, and "type" for anything but a peaking
# band - so the ten-band curve keeps the shape it always had.
Band = dict[str, Any]


def _type(band: Band) -> str:
    return band.get("type", PEAKING)


def sanitize(bands: object) -> list[Band]:
    """`bands` reduced to what may reach ffmpeg: well-formed bands inside
    the bounds above, flat ones dropped. An empty list means "no equalizer"."""
    if not isinstance(bands, list):
        return []
    clean: list[Band] = []
    for band in bands[:MAX_BANDS]:
        if not isinstance(band, dict):
            continue
        try:
            frequency = float(band["frequency"])
            gain = float(band["gain"])
            q = float(band["q"])
        except (KeyError, TypeError, ValueError):
            continue
        if not all(math.isfinite(v) for v in (frequency, gain, q)):
            continue
        kind = band.get("type", PEAKING)
        if kind not in _FFMPEG_FILTERS:
            continue
        if not MIN_FREQUENCY_HZ <= frequency <= MAX_FREQUENCY_HZ:
            continue
        gain = max(-MAX_GAIN_DB, min(MAX_GAIN_DB, gain))
        if round(gain, 2) == 0:
            continue
        clean_band: Band = {"frequency": frequency, "gain": gain, "q": max(MIN_Q, min(MAX_Q, q))}
        if kind != PEAKING:
            clean_band["type"] = kind
        clean.append(clean_band)
    return clean


def _coefficients(band: Band, rate: int) -> tuple[list[float], list[float]]:
    """The RBJ cookbook biquad for `band`: numerator and denominator.
    services/equalizer.ts has the same formulas for the renderer."""
    a = 10 ** (band["gain"] / 40)
    w0 = 2 * math.pi * band["frequency"] / rate
    alpha = math.sin(w0) / (2 * band["q"])
    cos_w0 = math.cos(w0)
    kind = _type(band)
    if kind == PEAKING:
        return (
            [1 + alpha * a, -2 * cos_w0, 1 - alpha * a],
            [1 + alpha / a, -2 * cos_w0, 1 - alpha / a],
        )
    shelf = 2 * math.sqrt(a) * alpha
    # The high shelf is the low one with the cosine's sign flipped.
    sign = 1 if kind == "lowshelf" else -1
    c = sign * cos_w0
    return (
        [
            a * ((a + 1) - (a - 1) * c + shelf),
            sign * 2 * a * ((a - 1) - (a + 1) * c),
            a * ((a + 1) - (a - 1) * c - shelf),
        ],
        [
            (a + 1) + (a - 1) * c + shelf,
            sign * -2 * ((a - 1) + (a + 1) * c),
            (a + 1) + (a - 1) * c - shelf,
        ],
    )


def _response_db(band: Band, freqs: np.ndarray, rate: int = _RESPONSE_RATE) -> np.ndarray:
    """One band's magnitude response in dB at `freqs`."""
    b, den = _coefficients(band, rate)
    z = np.exp(-1j * 2 * np.pi * freqs / rate)
    h = (b[0] + b[1] * z + b[2] * z**2) / (den[0] + den[1] * z + den[2] * z**2)
    return 20 * np.log10(np.abs(h))


def headroom_db(bands: list[Band]) -> float:
    """How far the whole curve is lowered so its loudest point stays at
    0 dB - the highest point of the combined response, not the highest
    band, since two neighbouring boosts add up between them. 0 for a curve
    that only cuts. stores/equalizer.ts works the same number out for the
    local graph."""
    if not bands:
        return 0.0
    freqs = np.geomspace(MIN_FREQUENCY_HZ, MAX_FREQUENCY_HZ, _RESPONSE_POINTS)
    total = sum(_response_db(band, freqs) for band in bands)
    return max(0.0, float(np.max(total)))


def audio_filter(gain: float, bands: list[Band]) -> str | None:
    """The `-af` chain for a ReplayGain factor and an equalizer curve, or
    None when neither changes anything. One volume filter carries both
    ReplayGain and the curve's headroom, so the two never compete for -af."""
    level = gain * 10 ** (-headroom_db(bands) / 20)
    parts = [f"volume={level:.6g}"] if abs(level - 1.0) > 1e-6 else []
    parts += [
        f"{_FFMPEG_FILTERS[_type(b)]}=f={b['frequency']:.6g}:t=q:w={b['q']:.6g}:g={b['gain']:.6g}"
        for b in bands
    ]
    return ",".join(parts) or None


# ── Live, in the mix ──────────────────────────────────────────────────────

# The live filter's length. A +12 dB band at 31 Hz rings for longer than
# 2048 taps (46 ms) hold, which cost it almost 2 dB of its peak; at 4096
# every curve the dialog can make is within 0.4 dB of the biquads'.
LIVE_TAPS = 4096
# The grid the filter is designed on: fine enough that the cepstrum below
# does not wrap around (and so smear the 31 Hz band).
_DESIGN_GRID = 1 << 15

BandsKey = tuple[tuple[float, float, float, str], ...]


def _bands_key(bands: list[Band]) -> BandsKey:
    return tuple((b["frequency"], b["gain"], b["q"], _type(b)) for b in bands)


@functools.lru_cache(maxsize=32)
def live_taps(key: BandsKey) -> np.ndarray:
    """The curve, headroom included, as a minimum-phase FIR filter.

    Minimum phase because a linear-phase one would delay everything by half
    its length (46 ms) - switching it in or out would then be heard as a
    jump. The biquads are minimum phase as well, so this is also the closest
    match to what ffmpeg and Web Audio do. Designed from the magnitude alone
    through the real cepstrum, since IIR filters cannot be run vectorised in
    numpy (see core/mix_dsp.py)."""
    bands = [{"frequency": f, "gain": g, "q": q, "type": t} for f, g, q, t in key]
    freqs = np.fft.rfftfreq(_DESIGN_GRID, 1 / SAMPLE_RATE)
    db = sum(_response_db(b, freqs, SAMPLE_RATE) for b in bands) - headroom_db(bands)
    log_magnitude = np.log(10.0 ** (db / 20))
    cepstrum = np.fft.irfft(log_magnitude, _DESIGN_GRID)
    folded = np.zeros(_DESIGN_GRID)
    half = _DESIGN_GRID // 2
    folded[0] = cepstrum[0]
    folded[1:half] = 2 * cepstrum[1:half]
    folded[half] = cepstrum[half]
    # Cut off where it has rung out: fading the tail as well was measured
    # to change nothing.
    return np.fft.irfft(np.exp(np.fft.rfft(folded)), _DESIGN_GRID)[:LIVE_TAPS]


@functools.lru_cache(maxsize=64)
def _taps_spectrum(key: BandsKey, size: int) -> np.ndarray:
    return np.fft.rfft(live_taps(key), size)[:, None]


class LiveEqualizer:
    """A curve on the mix's s16le stereo PCM, block by block, that can be
    changed between any two blocks. A change is crossfaded over the block it
    lands in - the old and the new curve's output, both from the same input
    - so moving a slider never clicks. With no curve, the PCM is handed back
    untouched."""

    def __init__(self) -> None:
        # The last LIVE_TAPS - 1 input frames: what the next block's filter
        # still reaches back into. Kept while bypassed, too, so a curve
        # switched on starts from the real signal rather than from silence.
        self._history = np.zeros((LIVE_TAPS - 1, 2), dtype=np.float64)
        # None until the first block: a listener starts with its curve
        # rather than fading into it.
        self._key: BandsKey | None = None
        self._dither = Dither()

    def process(self, pcm: bytes, bands: list[Band]) -> bytes:
        key = _bands_key(bands)
        if self._key is None:
            self._key = key
        x = pcm_to_float(pcm).astype(np.float64)
        frames = len(x)
        full = np.concatenate([self._history, x])
        self._history = full[-(LIVE_TAPS - 1) :]
        if key == self._key:
            if not key or frames == 0:
                return pcm
            y = self._filter(full, frames, key)
        else:
            old = self._filter(full, frames, self._key) if self._key else x
            new = self._filter(full, frames, key) if key else x
            self._key = key
            # Linear rather than equal power: the two are the same signal,
            # and correlated signals keep their level under a linear fade.
            ramp = (np.arange(1, frames + 1) / max(1, frames))[:, None]
            y = old * (1 - ramp) + new * ramp
        # The headroom keeps the curve at or under 0 dB, but a filter can
        # still put a peak over the input's - the mix is limited close to
        # full scale already.
        return self._dither.to_int16(soft_limit(y.astype(np.float32)))

    @staticmethod
    def _filter(full: np.ndarray, frames: int, key: BandsKey) -> np.ndarray:
        """Overlap-save: the input with its history, filtered by FFT, the
        history's part of the result dropped."""
        size = 1 << int(np.ceil(np.log2(len(full))))
        spectrum = np.fft.rfft(full, size, axis=0) * _taps_spectrum(key, size)
        return np.fft.irfft(spectrum, size, axis=0)[LIVE_TAPS - 1 : LIVE_TAPS - 1 + frames]


# Deliveries are typed loosely on purpose: core/streamer.py imports this
# module, and delivery/ imports core/ in turn.
def _deliveries(delivery: Any) -> list[Any]:
    """A DeliveryManager's targets, or a single delivery as a list of one."""
    if delivery is None:
        return []
    return list(getattr(delivery, "deliveries", [delivery]))


def _key(delivery: Any) -> str:
    """The same `type:name` core/state.py's list_target_pairs() produces."""
    return f"{type(delivery).__name__.replace('Delivery', '').lower()}:{delivery.target}"


def any_active(curves: dict[str, list[Band]], delivery: Any) -> bool:
    """Whether any target of this dispatch has a curve - which rules out
    handing the source over untouched for all of them, since they share one
    format (see core/streamer.py's resolve_output_format())."""
    return any(curves.get(_key(d)) for d in _deliveries(delivery))


def curve_for_connection(
    curves: dict[str, list[Band]],
    delivery: Any,
    peer: str | None,
    sender: str | None,
) -> list[Band]:
    """The curve for whichever target opened this /stream connection, told
    apart the way the stream diagnostics do it: the name connect put on the
    URL for a target it fetches for itself (AirPlay), otherwise the address
    the device fetched from. A lone target needs no telling apart. A Sonos
    group is fetched by its coordinator alone, so the coordinator's curve is
    what the whole group hears."""
    targets = _deliveries(delivery)
    if len(targets) == 1:
        return curves.get(_key(targets[0]), [])
    for d in targets:
        if sender is not None:
            if sender.lower() == d.target.lower():
                return curves.get(_key(d), [])
        elif peer is not None and peer == d.stream_peer:
            return curves.get(_key(d), [])
    return []
