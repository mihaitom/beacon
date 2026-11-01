/** The lights dialog's preview: a made-up song at 120 BPM that gets
 * louder and quieter and has a short breakdown, lit the way
 * connect/lights/show.py would light it. An approximation for choosing a
 * style and colours, not a copy - the real show runs in connect, on the
 * song's own beat. */

import type { LightsStyle } from '@/services/connect/lights'

export type Rgb = [number, number, number]

const BEAT_SECONDS = 0.5
const ENERGY_PERIOD_SECONDS = 16
// The last 8 beats of every 32 are a breakdown - no drums, no flashes -
// landing in the quiet half of the loudness swell.
const LOOP_BEATS = 32
const BREAKDOWN_FROM_BEAT = 24
const CALM_GLIDE_SECONDS = 8
// connect's ROTATION_BEATS (lights/controller.py).
const ROTATION_BEATS = 64

const WHITE: Rgb = [255, 255, 255]

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
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

/** The made-up song's beats heard by `t` seconds: every beat but the
 * breakdown's. */
export function heardBeats(t: number): number {
  const beat = Math.floor(t / BEAT_SECONDS)
  const loops = Math.floor(beat / LOOP_BEATS)
  return loops * BREAKDOWN_FROM_BEAT + Math.min(beat % LOOP_BEATS, BREAKDOWN_FROM_BEAT - 1)
}

/** How far the rotation has turned by `t`: on with the heard beats, still
 * through the breakdown, as connect turns it. */
export function previewTurn(t: number): number {
  return (heardBeats(t) / ROTATION_BEATS) % 1
}

let epoch: number | null = null

/** Seconds into the made-up song. One clock for everything showing it, so
 * the colour wheel's dots move on the beat the stage's lamps light on. */
export function previewTime(now = performance.now()): number {
  epoch ??= now
  return (now - epoch) / 1000
}

export function rgbToHex(rgb: Rgb): string {
  return '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** One colour per light, 0-255 at the brightness it would have at `t`;
 * the second value is that brightness, 0-1, for the glow around it. */
export function previewFrame(
  t: number,
  style: LightsStyle,
  palette: Rgb[],
  lights: number,
  brightness: number,
  rotate = false,
): { colour: Rgb; level: number }[] {
  if (rotate) palette = rotation(palette[0]!, lights, previewTurn(t))
  const energy = 0.55 + 0.45 * Math.sin((t / ENERGY_PERIOD_SECONDS) * 2 * Math.PI)
  const beat = Math.floor(t / BEAT_SECONDS)
  const since = t - beat * BEAT_SECONDS
  const downbeat = beat % 4 === 0
  const hit = beat % LOOP_BEATS < BREAKDOWN_FROM_BEAT ? 1 : 0
  // For party's colour swaps and the chase: they hold in a breakdown.
  const heard = heardBeats(t)
  const floor = 0.12 + 0.38 * energy
  const out: { colour: Rgb; level: number }[] = []

  for (let i = 0; i < lights; i++) {
    let colour = palette[i % palette.length]!
    let level: number
    if (style === 'calm') {
      level = 0.2 + 0.55 * energy
      const k = (t / CALM_GLIDE_SECONDS + i) % palette.length
      const a = Math.floor(k)
      colour = mix(palette[a]!, palette[(a + 1) % palette.length]!, k - a)
    } else if (style === 'party') {
      const colours = palette.length > 1 ? palette : [palette[0]!, secondColour(palette[0]!)]
      colour = colours[(i + heard) % colours.length]!
      level = 0.06 + 0.2 * energy + hit * (0.55 + 0.35 * energy) * Math.exp(-since / 0.14)
      if (downbeat) colour = mix(colour, WHITE, hit * 0.75 * Math.exp(-since / 0.1))
    } else if (style === 'chase') {
      const peak = hit * (0.55 + 0.3 * energy)
      level = floor * 0.6
      if (i === heard % lights) level += peak * (0.35 + 0.65 * Math.exp(-since / 0.25))
      else if (lights > 1 && i === (heard + lights - 1) % lights) {
        level += peak * 0.35 * Math.exp(-since / 0.12)
      }
    } else {
      let pulse = hit * (0.35 + 0.25 * energy) * Math.exp(-since / 0.18) * (downbeat ? 1.3 : 1)
      const side = i < lights / 2 ? 0 : 1
      if (lights > 1 && !downbeat && side !== beat % 2) pulse *= 0.55
      level = floor + pulse
      if (downbeat) colour = mix(colour, WHITE, 0.35 * Math.min(1, pulse))
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
