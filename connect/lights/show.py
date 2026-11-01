"""lights/show.py — what every light shows at a given moment of a song.

Pure functions of the song's analysis and its position, so the look can be
tested and tuned without a bridge. Four styles:

- pulse: dim between beats and brighter the louder the section, a short
  flash on every beat (the first of a bar stronger, with a touch of
  white); lights on the left and right take turns.

Every flash is as strong as its beat is heard (SongLights.hit): through a
breakdown the beats count on, the flashes do not.
- calm: no flashes; brightness follows the loudness, the colours glide
  from light to light.
- party: hard hits, the lights swap colours on every beat, a white flash
  on the first of a bar.
- chase: every beat hands on to the next light, left to right and round
  again; one lights up at a time while the others glow. It moves only on
  a beat that is heard, so it stands still through a breakdown.

`palette` is one colour or several; with several, the lights take them in
turn from left to right.
"""

from __future__ import annotations

import math
from typing import Literal

from .analysis import RGB, SongLights
from .hue import Channel

Style = Literal["pulse", "calm", "party", "chase"]
STYLES: tuple[Style, ...] = ("pulse", "calm", "party", "chase")

# Brightness between beats, at the song's quietest and loudest.
_FLOOR = 0.12
_FLOOR_RANGE = 0.38
# A beat's flash on top of that, and how fast it fades. Short enough to
# read as a hit at 180 BPM (a beat every 0.33 s), long enough that a
# bridge updating 25 times a second shows more than a single frame of it.
_PULSE = 0.35
_PULSE_RANGE = 0.25
_PULSE_DECAY_SECONDS = 0.18
_DOWNBEAT_BOOST = 1.3
_DOWNBEAT_WHITE = 0.35
# The light on the off side of a beat still pulses, just less.
_OFF_SIDE = 0.55

_CALM_FLOOR = 0.2
_CALM_RANGE = 0.55
# How long the colours take to move one light further.
_CALM_GLIDE_SECONDS = 8.0

_PARTY_FLOOR = 0.06
_PARTY_FLOOR_RANGE = 0.2
_PARTY_PULSE = 0.55
_PARTY_PULSE_RANGE = 0.35
_PARTY_DECAY_SECONDS = 0.14
_PARTY_WHITE = 0.75
_PARTY_WHITE_DECAY_SECONDS = 0.1

# Of pulse's floor, low enough that the one light on stands out.
_CHASE_FLOOR = 0.6
_CHASE_PULSE = 0.55
_CHASE_PULSE_RANGE = 0.3
# The lit light keeps this share of its hit until the next beat, so it
# reads as "this one's turn" rather than a flash anywhere; the one before
# lets go quickly, so the hand-over shows which way it runs.
_CHASE_HOLD = 0.35
_CHASE_DECAY_SECONDS = 0.25
_CHASE_TAIL = 0.35
_CHASE_TAIL_DECAY_SECONDS = 0.12

# Without a beat to follow: brightness by loudness alone.
_NO_BEAT_FLOOR = 0.15
_NO_BEAT_RANGE = 0.6
# While a song is still being analysed.
_WAITING = 0.4


def _clamp(v: float) -> float:
    return max(0.0, min(1.0, v))


def scale(colour: RGB, level: float) -> RGB:
    return (colour[0] * level, colour[1] * level, colour[2] * level)


def _towards_white(colour: RGB, amount: float) -> RGB:
    return blend(colour, (1.0, 1.0, 1.0), amount)


def blend(a: RGB, b: RGB, amount: float) -> RGB:
    """`a` moved `amount` of the way towards `b`."""
    k = _clamp(amount)
    return (a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k)


def side(channel: Channel) -> int:
    """0 for the left half of the room (as set up in the Hue app), 1 for
    the right."""
    return 0 if channel.x < 0 else 1


def left_to_right(channels: tuple[Channel, ...]) -> list[Channel]:
    return sorted(channels, key=lambda ch: (ch.x, ch.channel_id))


def _second_colour(colour: RGB) -> RGB:
    """Something to swap with when a party has only one colour: the same
    colour with its channels rotated, a hue a third of the wheel away."""
    return (colour[2], colour[0], colour[1])


def heard_beats_at(song: SongLights | None, t: float) -> int | None:
    """How many beats of `song` were heard by `t`; None without a beat to
    count."""
    beat = song.beat_at(t) if song is not None else None
    if beat is None:
        return None
    return song.heard_beats(beat[0])


def frame(
    t: float,
    song: SongLights | None,
    palette: tuple[RGB, ...],
    channels: tuple[Channel, ...],
    style: Style = "pulse",
    brightness: float = 1.0,
) -> dict[int, RGB]:
    ordered = left_to_right(channels)
    # Each light's colour from the palette, in turn from the left.
    base = {ch.channel_id: palette[i % len(palette)] for i, ch in enumerate(ordered)}
    out = _levels(t, song, tuple(dict.fromkeys(palette)), base, ordered, style)
    return {cid: scale(colour, brightness) for cid, colour in out.items()}


def _levels(
    t: float,
    song: SongLights | None,
    palette: tuple[RGB, ...],
    base: dict[int, RGB],
    ordered: list[Channel],
    style: Style,
) -> dict[int, RGB]:
    if song is None:
        return {cid: scale(c, _WAITING) for cid, c in base.items()}

    energy = song.energy_at(t)
    if style == "calm":
        return _calm(t, energy, palette, ordered)

    beat = song.beat_at(t)
    if beat is None:
        level = _clamp(_NO_BEAT_FLOOR + _NO_BEAT_RANGE * energy)
        return {cid: scale(c, level) for cid, c in base.items()}

    beat_index, since = beat
    downbeat = song.is_downbeat(beat_index)
    hit = song.hit(beat_index)

    if style in ("party", "chase"):
        step = song.heard_beats(beat_index)
        if style == "chase":
            return _chase(since, step, hit, energy, base, ordered)
        return _party(since, step, downbeat, hit, energy, palette, ordered)
    return _pulse(since, beat_index, downbeat, hit, energy, base, ordered)


def _pulse(
    since: float,
    beat_index: int,
    downbeat: bool,
    hit: float,
    energy: float,
    base: dict[int, RGB],
    ordered: list[Channel],
) -> dict[int, RGB]:
    pulse = hit * (_PULSE + _PULSE_RANGE * energy) * math.exp(-since / _PULSE_DECAY_SECONDS)
    if downbeat:
        pulse *= _DOWNBEAT_BOOST
    floor = _FLOOR + _FLOOR_RANGE * energy
    two_sided = len({side(ch) for ch in ordered}) > 1

    out: dict[int, RGB] = {}
    for ch in ordered:
        colour = base[ch.channel_id]
        on_side = not two_sided or downbeat or side(ch) == beat_index % 2
        p = pulse if on_side else pulse * _OFF_SIDE
        tone = _towards_white(colour, _DOWNBEAT_WHITE * min(1.0, p)) if downbeat else colour
        out[ch.channel_id] = scale(tone, _clamp(floor + p))
    return out


def _calm(
    t: float, energy: float, palette: tuple[RGB, ...], ordered: list[Channel]
) -> dict[int, RGB]:
    level = _clamp(_CALM_FLOOR + _CALM_RANGE * energy)
    # Each light one step further along the palette, all of them moving
    # on by one step every glide period.
    out: dict[int, RGB] = {}
    for i, ch in enumerate(ordered):
        k = (t / _CALM_GLIDE_SECONDS + i) % len(palette)
        a = int(k)
        colour = blend(palette[a], palette[(a + 1) % len(palette)], k - a)
        out[ch.channel_id] = scale(colour, level)
    return out


def _party(
    since: float,
    step: int,
    downbeat: bool,
    hit: float,
    energy: float,
    palette: tuple[RGB, ...],
    ordered: list[Channel],
) -> dict[int, RGB]:
    """`step` counts the beats heard so far: the colours swap on a beat,
    and hold while there is none."""
    colours = list(palette)
    if len(colours) < 2:
        colours.append(_second_colour(colours[0]))
    decay = math.exp(-since / _PARTY_DECAY_SECONDS)
    pulse = hit * (_PARTY_PULSE + _PARTY_PULSE_RANGE * energy) * decay
    level = _clamp(_PARTY_FLOOR + _PARTY_FLOOR_RANGE * energy + pulse)
    white = hit * _PARTY_WHITE * math.exp(-since / _PARTY_WHITE_DECAY_SECONDS) if downbeat else 0.0

    out: dict[int, RGB] = {}
    for i, ch in enumerate(ordered):
        colour = colours[(i + step) % len(colours)]
        out[ch.channel_id] = scale(_towards_white(colour, white), level)
    return out


def _chase(
    since: float,
    step: int,
    hit: float,
    energy: float,
    base: dict[int, RGB],
    ordered: list[Channel],
) -> dict[int, RGB]:
    """`step` counts the beats heard so far; the light whose turn it is
    lights up as strongly as the beat is heard."""
    floor = (_FLOOR + _FLOOR_RANGE * energy) * _CHASE_FLOOR
    peak = hit * (_CHASE_PULSE + _CHASE_PULSE_RANGE * energy)
    n = len(ordered)
    lit, before = step % n, (step - 1) % n
    out: dict[int, RGB] = {}
    for i, ch in enumerate(ordered):
        level = floor
        if i == lit:
            hold = _CHASE_HOLD + (1 - _CHASE_HOLD) * math.exp(-since / _CHASE_DECAY_SECONDS)
            level += peak * hold
        elif i == before and n > 1:
            level += peak * _CHASE_TAIL * math.exp(-since / _CHASE_TAIL_DECAY_SECONDS)
        out[ch.channel_id] = scale(base[ch.channel_id], _clamp(level))
    return out
