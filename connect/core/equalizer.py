"""core/equalizer.py — a speaker's equalizer curve, as ffmpeg filters.

The curve is the listener's (stores/equalizer.ts in the renderer): a list of
peaking bands, each a centre frequency, a gain and a Q. The renderer plays
the same bands through Web Audio's BiquadFilterNode for this device's own
playback, and both that and ffmpeg's `equalizer` filter are the RBJ cookbook
peaking biquad - so a curve sounds the same in the app and on a speaker.
The bands travel as numbers rather than being defined twice.

Curves are kept per speaker, keyed `type:name` like the device volumes
(SessionState.device_volumes), because the point is mostly the speaker: a
kitchen box without bass should not hand its bass boost to the living room.
"""

import math
from typing import Any

import numpy as np

# What one band may ask for. The renderer offers ±12 dB; the bounds here
# only keep a hand-made request from reaching ffmpeg as nonsense.
MAX_GAIN_DB = 12.0
MIN_FREQUENCY_HZ = 20.0
MAX_FREQUENCY_HZ = 20000.0
MIN_Q = 0.1
MAX_Q = 10.0
MAX_BANDS = 16

# The rate the headroom is worked out at. The response of a biquad shifts a
# little with the sample rate near Nyquist; 48 kHz is what the renderer's
# AudioContext usually runs at, and the peak this finds sits well below
# that region for any curve the dialog can make.
_RESPONSE_RATE = 48000
# Enough points that two adjacent boosted bands' combined peak, which lies
# between their centres, is not missed: 1/40 octave at 400 points.
_RESPONSE_POINTS = 400

Band = dict[str, float]


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
        if not MIN_FREQUENCY_HZ <= frequency <= MAX_FREQUENCY_HZ:
            continue
        gain = max(-MAX_GAIN_DB, min(MAX_GAIN_DB, gain))
        if round(gain, 2) == 0:
            continue
        clean.append({"frequency": frequency, "gain": gain, "q": max(MIN_Q, min(MAX_Q, q))})
    return clean


def _peaking_response_db(band: Band, freqs: np.ndarray) -> np.ndarray:
    """One RBJ peaking band's magnitude response in dB at `freqs`."""
    a = 10 ** (band["gain"] / 40)
    w0 = 2 * math.pi * band["frequency"] / _RESPONSE_RATE
    alpha = math.sin(w0) / (2 * band["q"])
    cos_w0 = math.cos(w0)
    b = np.array([1 + alpha * a, -2 * cos_w0, 1 - alpha * a])
    den = np.array([1 + alpha / a, -2 * cos_w0, 1 - alpha / a])
    z = np.exp(-1j * 2 * np.pi * freqs / _RESPONSE_RATE)
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
    total = sum(_peaking_response_db(band, freqs) for band in bands)
    return max(0.0, float(np.max(total)))


def audio_filter(gain: float, bands: list[Band]) -> str | None:
    """The `-af` chain for a ReplayGain factor and an equalizer curve, or
    None when neither changes anything. One volume filter carries both
    ReplayGain and the curve's headroom, so the two never compete for -af."""
    level = gain * 10 ** (-headroom_db(bands) / 20)
    parts = [f"volume={level:.6g}"] if abs(level - 1.0) > 1e-6 else []
    parts += [
        f"equalizer=f={b['frequency']:.6g}:t=q:w={b['q']:.6g}:g={b['gain']:.6g}" for b in bands
    ]
    return ",".join(parts) or None


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
