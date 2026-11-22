import type { MilkdropVisualizer } from 'butterchurn'

/** A preset of Beacon's own can say what is on screen: its file lists
 * captions, and its frame equations set q32 to the one that applies - 1
 * for the first, 0 for none. Butterchurn has no way back from a preset,
 * but it keeps each frame's q values. */
const CAPTION_Q = 'q32'

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

/** The caption the preset on screen asked for in its last frame, if any. */
export function currentCaption(
  visualizer: MilkdropVisualizer,
  captions: readonly string[] | undefined,
): string | null {
  if (!captions?.length) return null
  const qs = (visualizer as unknown as EquationInternals).renderer?.presetEquationRunner
    ?.mdVSQAfterFrame
  const number = qs?.[CAPTION_Q]
  if (typeof number !== 'number' || !Number.isFinite(number)) return null
  return captions[Math.round(number) - 1] ?? null
}
