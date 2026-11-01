/** The lights dialog's preview of a style: a made-up song at 120 BPM that
 * gets louder and quieter, lit the way connect/lights/show.py would light
 * it. An approximation for choosing a style, not a copy - the real show
 * runs in connect, on the song's own beat. */

import type { LightsStyle } from '@/services/connect/lights'

export type Rgb = [number, number, number]

const BEAT_SECONDS = 0.5
const ENERGY_PERIOD_SECONDS = 16
const CALM_GLIDE_SECONDS = 8
const WAVE_SPAN_SECONDS = 0.22

const WHITE: Rgb = [255, 255, 255]

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
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
): { colour: Rgb; level: number }[] {
  const energy = 0.55 + 0.45 * Math.sin((t / ENERGY_PERIOD_SECONDS) * 2 * Math.PI)
  const beat = Math.floor(t / BEAT_SECONDS)
  const since = t - beat * BEAT_SECONDS
  const downbeat = beat % 4 === 0
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
      const colours = palette.length > 1 ? palette : [palette[0]!, rotate(palette[0]!)]
      colour = colours[(i + beat) % colours.length]!
      level = 0.06 + 0.2 * energy + (0.55 + 0.35 * energy) * Math.exp(-since / 0.14)
      if (downbeat) colour = mix(colour, WHITE, 0.75 * Math.exp(-since / 0.1))
    } else if (style === 'wave') {
      const reached = since - (lights > 1 ? (WAVE_SPAN_SECONDS * i) / (lights - 1) : 0)
      const pulse = reached >= 0 ? (0.45 + 0.25 * energy) * Math.exp(-reached / 0.16) : 0
      level = floor * 0.8 + pulse
    } else {
      let pulse = (0.35 + 0.25 * energy) * Math.exp(-since / 0.18) * (downbeat ? 1.3 : 1)
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
function rotate(c: Rgb): Rgb {
  return [c[2], c[0], c[1]]
}
