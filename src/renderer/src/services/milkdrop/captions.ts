import type { MilkdropVisualizer } from 'butterchurn'

/** A preset of Beacon's own can say what is on screen: its file lists
 * captions, and its frame equations set q32 to the one that applies - 1
 * for the first, 0 for none. One that zooms can report how far, as q31 in
 * doublings. Butterchurn has no way back from a preset, but it keeps each
 * frame's q values. */
const CAPTION_Q = 'q32'
const ZOOM_Q = 'q31'

export interface MilkdropCaption {
  text: string
}

/** The part of Butterchurn's renderer this reads. Pinned to 2.6.7 like
 * textures.ts; a version that moves it shows no captions rather than
 * breaking (and captions.browser.test.ts fails). */
interface EquationInternals {
  renderer?: {
    presetEquationRunner?: {
      mdVSQAfterFrame?: Record<string, unknown> | null
    }
  }
}

/** A value the preset on screen set in its last frame (q1 to q32). */
export function lastFrame(visualizer: MilkdropVisualizer, q: string): number | null {
  const qs = (visualizer as unknown as EquationInternals).renderer?.presetEquationRunner
    ?.mdVSQAfterFrame
  const value = qs?.[q]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The caption the preset on screen asked for in its last frame, if any. */
export function currentCaption(
  visualizer: MilkdropVisualizer,
  captions: readonly MilkdropCaption[] | undefined,
): MilkdropCaption | null {
  if (!captions?.length) return null
  const number = lastFrame(visualizer, CAPTION_Q)
  return number === null ? null : (captions[Math.round(number) - 1] ?? null)
}

/** How far the preset on screen has zoomed in, in doublings. */
export function currentZoom(visualizer: MilkdropVisualizer): number | null {
  return lastFrame(visualizer, ZOOM_Q)
}

/** The factor as a power of two - how deep zooms are told apart - with
 * the power "37" in the locale's own digits, for the page to set raised:
 * of the superscript characters, a font often has only ¹ ² ³ and fetches
 * the rest from another, which shows. */
export interface ZoomText {
  exponent: string
}

export function formatZoom(doublings: number, locale: string): ZoomText {
  const whole = Math.max(0, Math.round(doublings))
  return { exponent: new Intl.NumberFormat(locale, { useGrouping: false }).format(whole) }
}
