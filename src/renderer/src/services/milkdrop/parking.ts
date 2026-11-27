import type { MilkdropVisualizer } from 'butterchurn'

/** Keeps the last visualizer's WebGL context alive after Milkdrop leaves
 * the screen, so coming back finds every preset it compiled still compiled
 * (see shaderCompile.ts) - the heaviest takes half a minute on a laptop.
 * One context at most: the browser drops the oldest once a page holds too
 * many. */

export interface ParkedVisualizer {
  canvas: HTMLCanvasElement
  visualizer: MilkdropVisualizer
  /** The audio context it was made with; Butterchurn's analysers live in
   * it, so a different one cannot be connected. */
  audio: BaseAudioContext
}

// Small enough that a parked context holds next to no GPU memory.
const PARKED_SIZE = 16

let parked: ParkedVisualizer | null = null

function gl(entry: ParkedVisualizer): WebGL2RenderingContext | null {
  return entry.canvas.getContext('webgl2')
}

function lose(entry: ParkedVisualizer): void {
  gl(entry)?.getExtension('WEBGL_lose_context')?.loseContext()
}

export function park(entry: ParkedVisualizer): void {
  if (parked && parked.canvas !== entry.canvas) lose(parked)
  entry.canvas.width = entry.canvas.height = PARKED_SIZE
  entry.visualizer.setRendererSize(PARKED_SIZE, PARKED_SIZE, { pixelRatio: 1 })
  parked = entry
}

/** The parked visualizer, if it still works and fits: `audio` is the
 * context an analyser will be connected from, or null when the samples
 * are handed over per frame and any context will do. */
export function unpark(audio: BaseAudioContext | null): ParkedVisualizer | null {
  const entry = parked
  parked = null
  if (!entry) return null
  if (gl(entry)?.isContextLost() !== false || (audio && audio !== entry.audio)) {
    lose(entry)
    return null
  }
  return entry
}
