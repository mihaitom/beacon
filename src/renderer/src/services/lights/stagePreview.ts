/** The lights dialog's preview, lit the way connect/lights/show.py would
 * light it. It plays along with the song that is playing, on connect's
 * analysis of it (its beats, how strongly each is heard, its loudness);
 * with nothing playing, a made-up song at 120 BPM that gets louder and
 * quieter and has a short breakdown. An approximation for choosing a style
 * and colours, not a copy - the real show runs in connect. */

import type { LightsStyle, SongAnalysis } from '@/services/connect/lights'

export type Rgb = [number, number, number]

/** What the preview needs of a song - connect's SongLights. */
export interface PreviewSong {
  /** 0-1, 1 the song's own loud part. */
  energyAt(t: number): number
  /** The number of the last beat by `t` and the seconds since it; null
   * for a song without a beat to follow. */
  beatAt(t: number): [number, number] | null
  isDownbeat(beat: number): boolean
  /** 0-1: how strongly the beat is heard. */
  hit(beat: number): number
  /** Beats heard as one up to `beat`: a count that stands still through a
   * breakdown. */
  heardBeats(beat: number): number
  /** How far into a breakdown `t` is and how much of what plays in it is
   * moving, each 0-1. */
  restAt(t: number): [number, number]
}

const BEAT_SECONDS = 0.5
const ENERGY_PERIOD_SECONDS = 16
// The last 8 beats of every 32 are a breakdown - no drums, no flashes -
// landing in the quiet half of the loudness swell.
const LOOP_BEATS = 32
const BREAKDOWN_FROM_BEAT = 24
// Something in the breakdown moves every this many beats, and fades out.
const BREAKDOWN_MOVES_EVERY_BEATS = 2
const SWELL_DECAY_SECONDS = 0.5
// connect's _BREATH (lights/show.py).
const BREATH = 0.2
const CALM_GLIDE_SECONDS = 8
// connect's ROTATION_BEATS (lights/controller.py).
const ROTATION_BEATS = 64

const WHITE: Rgb = [255, 255, 255]

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** Python's %: never negative, for a count from before the first beat. */
function wrap(n: number, by: number): number {
  return ((n % by) + by) % by
}

/** The made-up song, for when nothing is playing. */
export const MADE_UP_SONG: PreviewSong = {
  energyAt: (t) => 0.55 + 0.45 * Math.sin((t / ENERGY_PERIOD_SECONDS) * 2 * Math.PI),
  beatAt(t) {
    const beat = Math.floor(t / BEAT_SECONDS)
    return [beat, t - beat * BEAT_SECONDS]
  },
  isDownbeat: (beat) => beat % 4 === 0,
  hit: (beat) => (wrap(beat, LOOP_BEATS) < BREAKDOWN_FROM_BEAT ? 1 : 0),
  heardBeats(beat) {
    const loops = Math.floor(beat / LOOP_BEATS)
    return loops * BREAKDOWN_FROM_BEAT + Math.min(wrap(beat, LOOP_BEATS), BREAKDOWN_FROM_BEAT - 1)
  },
  restAt(t) {
    const beats = t / BEAT_SECONDS
    const into = wrap(beats, LOOP_BEATS) - BREAKDOWN_FROM_BEAT
    if (into < 0) return [0, 0]
    const sinceMove = wrap(beats, BREAKDOWN_MOVES_EVERY_BEATS) * BEAT_SECONDS
    return [Math.min(1, into / 4), Math.exp(-sinceMove / SWELL_DECAY_SECONDS)]
  },
}

/** A song as connect analysed it, read the way SongLights reads itself. */
export function analysedSong(analysis: SongAnalysis): PreviewSong {
  const { energy, energy_rate: rate, beats, hits } = analysis
  // Heard beats up to each one, counted once rather than on every frame.
  let heard = 0
  const heardUpTo = (hits ?? []).map((h) => (h >= analysis.heard_from ? ++heard : heard))

  return {
    energyAt(t) {
      if (!energy.length) return 0.5
      return energy[Math.min(Math.floor(Math.max(0, t) * rate), energy.length - 1)]!
    },
    beatAt(t) {
      if (!beats?.times.length) return null
      const { times, period } = beats
      const first = times[0]!
      const last = times[times.length - 1]!
      // Before the first beat and after the last the count runs on at the
      // song's tempo.
      if (t < first) {
        const i = Math.floor((t - first) / period)
        return [i, t - (first + i * period)]
      }
      if (t >= last) {
        const i = Math.floor((t - last) / period)
        return [times.length - 1 + i, t - (last + i * period)]
      }
      let lo = 0
      let hi = times.length - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (times[mid]! <= t) lo = mid
        else hi = mid
      }
      return [lo, t - times[lo]!]
    },
    isDownbeat: (beat) => !!beats && (beat - beats.downbeat) % 4 === 0,
    hit: (beat) => (hits && beat >= 0 && beat < hits.length ? hits[beat]! : 1),
    heardBeats(beat) {
      if (!hits || beat < 0) return beat
      if (beat < hits.length) return heardUpTo[beat]!
      return (heardUpTo[hits.length - 1] ?? 0) + beat + 1 - hits.length
    },
    restAt(t) {
      const i = Math.floor(Math.max(0, t) * analysis.rest_rate)
      return [analysis.lull?.[i] ?? 0, analysis.swell?.[i] ?? 0]
    },
  }
}

/** The hue of a colour, 0-1. */
export function hueOf([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b)
  const span = max - Math.min(r, g, b)
  if (!span) return 0
  const h = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4
  return (((h / 6) % 1) + 1) % 1
}

/** The fully saturated, full-value colour of hue `h` (0-1). */
export function fromHue(h: number): Rgb {
  const k = (n: number) => (n + h * 6) % 6
  const f = (n: number) => 255 * (1 - Math.max(0, Math.min(k(n), 4 - k(n), 1)))
  return [f(5), f(3), f(1)]
}

/** A colour per light, evenly round the wheel from `start`'s hue, turned
 * on by `turn` (a whole turn is 1) - connect's rotation(). */
export function rotation(start: Rgb, lights: number, turn: number): Rgb[] {
  const n = Math.max(lights, 1)
  const from = hueOf(start) + turn
  return Array.from({ length: n }, (_, i) => fromHue((from + i / n) % 1))
}

/** How far the rotation has turned by `t`: on with the heard beats, still
 * through a breakdown, as connect turns it. Counted from the song's start,
 * where connect carries it on from song to song. */
export function previewTurn(song: PreviewSong, t: number): number {
  const beat = song.beatAt(t)
  return beat ? wrap(song.heardBeats(beat[0]) / ROTATION_BEATS, 1) : 0
}

let epoch: number | null = null

/** Seconds into the made-up song. One clock for everything showing it, so
 * the colour wheel's dots move on the beat the stage's lamps light on. */
export function previewTime(now = performance.now()): number {
  epoch ??= now
  return (now - epoch) / 1000
}

// The app's position moves every 200-250 ms; past a second without one,
// playback has stalled rather than moved on.
const MAX_EXTRAPOLATION_SECONDS = 1

/** A clock on the playing song's position that runs on smoothly between
 * the steps the app reports it in. */
export function playbackClock(): (now: number, position: number, playing: boolean) => number {
  let anchor = { position: NaN, at: 0 }
  return (now, position, playing) => {
    if (position !== anchor.position) anchor = { position, at: now }
    if (!playing) return position
    return position + Math.min((now - anchor.at) / 1000, MAX_EXTRAPOLATION_SECONDS)
  }
}

export function rgbToHex(rgb: Rgb): string {
  return '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `floor`, lifted as far as a breakdown has come - connect's _rested(). */
function rested(floor: number, energy: number, [lull, swell]: [number, number]): number {
  return floor + lull * (Math.max(0, 0.16 + 0.44 * energy - floor) + BREATH * swell)
}

/** One colour per light, 0-255 at the brightness it would have at `t`;
 * the second value is that brightness, 0-1, for the glow around it. */
export function previewFrame(
  t: number,
  song: PreviewSong,
  style: LightsStyle,
  palette: Rgb[],
  lights: number,
  brightness: number,
  rotate = false,
): { colour: Rgb; level: number }[] {
  if (rotate) palette = rotation(palette[0]!, lights, previewTurn(song, t))
  const energy = song.energyAt(t)
  const beat = song.beatAt(t)
  const out: { colour: Rgb; level: number }[] = []

  for (let i = 0; i < lights; i++) {
    let colour = palette[i % palette.length]!
    let level: number
    if (style === 'calm') {
      level = 0.2 + 0.55 * energy
      const k = (t / CALM_GLIDE_SECONDS + i) % palette.length
      const a = Math.floor(k)
      colour = mix(palette[a]!, palette[(a + 1) % palette.length]!, k - a)
    } else if (!beat) {
      // No beat to follow: brightness by loudness alone.
      level = 0.15 + 0.6 * energy
    } else {
      const [index, since] = beat
      const downbeat = song.isDownbeat(index)
      const rest = song.restAt(t)
      const hit = song.hit(index) * (1 - rest[0])
      // For party's colour swaps and the chase: they hold in a breakdown.
      const heard = song.heardBeats(index)
      const floor = 0.12 + 0.38 * energy
      if (style === 'party') {
        const colours = palette.length > 1 ? palette : [palette[0]!, secondColour(palette[0]!)]
        colour = colours[wrap(i + heard, colours.length)]!
        level =
          rested(0.06 + 0.2 * energy, energy, rest) +
          hit * (0.55 + 0.35 * energy) * Math.exp(-since / 0.14)
        if (downbeat) colour = mix(colour, WHITE, hit * 0.75 * Math.exp(-since / 0.1))
      } else if (style === 'chase') {
        const peak = hit * (0.55 + 0.3 * energy)
        level = rested(floor * 0.6, energy, rest)
        if (i === wrap(heard, lights)) level += peak * (0.35 + 0.65 * Math.exp(-since / 0.25))
        else if (lights > 1 && i === wrap(heard - 1, lights)) {
          level += peak * 0.35 * Math.exp(-since / 0.12)
        }
      } else {
        let pulse = hit * (0.35 + 0.25 * energy) * Math.exp(-since / 0.18) * (downbeat ? 1.3 : 1)
        const side = i < lights / 2 ? 0 : 1
        if (lights > 1 && !downbeat && side !== wrap(index, 2)) pulse *= 0.55
        level = rested(floor, energy, rest) + pulse
        if (downbeat) colour = mix(colour, WHITE, 0.35 * Math.min(1, pulse))
      }
    }
    level = Math.min(1, level) * brightness
    out.push({ colour, level })
  }
  return out
}

/** connect's stand-in second colour for a one-colour party. */
function secondColour(c: Rgb): Rgb {
  return [c[2], c[0], c[1]]
}
