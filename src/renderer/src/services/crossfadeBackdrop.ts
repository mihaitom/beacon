/** Shared state for the blurred artwork backdrop behind the app's hero
 * surfaces (HomeView's hero band, DetailHeader's album/artist/genre/
 * playlist headers, the Now Playing view).
 *
 * Exists because the obvious implementation — one element whose
 * background-image is bound to the current artwork — cannot fade. A CSS
 * `transition` on background-image doesn't interpolate between two url()s;
 * there is nothing for the browser to blend between two arbitrary images,
 * so it swaps at the halfway point, which reads as a hard cut even though a
 * transition is declared.
 *
 * So each host renders *two* stacked layers and only ever shows one: a new
 * image goes onto the currently hidden layer, then the two swap, and a
 * plain opacity transition on the visible one does the actual crossfade.
 * That bookkeeping is what lives here — the layers' own look (blur radius,
 * inset, brightness) stays with each host, since those genuinely differ.
 */

export interface BackdropLayers {
  /** The two layers' image URLs; null means "nothing loaded on this one
   * yet", which renders as an empty layer rather than a broken image. */
  urls: (string | null)[]
  /** Index into `urls` of the layer currently at opacity 1. */
  active: number
}

export function createBackdropLayers(): BackdropLayers {
  return { urls: [null, null], active: 0 }
}

/** Show `url`, fading out of whatever is on screen now. Putting it on the
 * inactive layer first is what leaves the previous image in place to fade
 * out of — replacing the active layer's own image would cut instead. */
export function showBackdrop(layers: BackdropLayers, url: string | null): void {
  const next = layers.active === 0 ? 1 : 0
  layers.urls[next] = url
  layers.active = next
}
