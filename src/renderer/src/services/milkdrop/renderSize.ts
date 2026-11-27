/** Up to here the picture is drawn in the screen's own pixels, past it
 * scaled up. Beacon's presets have sharp edges (the cover, a fractal's
 * filaments) that blur visibly when scaled; a 4K screen is still drawn at
 * a quarter of its pixels, since the cost grows with their number. */
export const MAX_RENDER_EDGE = 2560

/** The canvas size for a box of `cssWidth` x `cssHeight` CSS pixels on a
 * screen with `pixelRatio` device pixels to each. */
export function renderSize(
  cssWidth: number,
  cssHeight: number,
  pixelRatio: number,
): { width: number; height: number } {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1
  const width = Math.max(1, cssWidth) * ratio
  const height = Math.max(1, cssHeight) * ratio
  const scale = Math.min(1, MAX_RENDER_EDGE / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}
