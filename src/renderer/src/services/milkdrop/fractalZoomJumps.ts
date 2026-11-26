/** Sending the Fractal Zoom straight to one scene (the Milkdrop menu's
 * "Jump to") instead of waiting for the dice. Its frame equations read
 * `globalThis.beaconFractalZoomPick` - an index into their scene table -
 * and cut to that scene at once. */
export const FRACTAL_ZOOM_KEY = 'builtin:beacon-fractal-zoom'

export interface FractalZoomDestination {
  label: string
  scene: number
}

export const FRACTAL_ZOOM_DESTINATIONS: FractalZoomDestination[] = [
  { label: 'Mandelbrot · Misiurewicz point M4,1', scene: 0 },
  { label: 'Mandelbrot · Elephant Valley', scene: 1 },
  { label: 'Mandelbrot · Misiurewicz point M38,5', scene: 2 },
  { label: 'Mandelbrot · The antenna', scene: 3 },
  { label: 'Mandelbrot · Seahorse Valley', scene: 4 },
  { label: 'Julia set · Douady rabbit', scene: 5 },
  { label: 'Julia set · Dendrite', scene: 6 },
  { label: 'Julia set · Dendrite, turned', scene: 7 },
  { label: 'Julia set · c = −0.7269 + 0.1889i', scene: 8 },
  { label: 'Julia set · c = −0.4 + 0.6i', scene: 9 },
  { label: 'Julia set · c = −0.54 + 0.54i', scene: 10 },
  { label: 'Julia set · c = −0.62 + 0.43i', scene: 11 },
  { label: 'Julia set · Siegel disk', scene: 12 },
  { label: 'Julia set · Airplane', scene: 18 },
  { label: 'Julia set · Basilica', scene: 13 },
  { label: 'Burning Ship', scene: 14 },
  { label: 'Cubic Multibrot', scene: 15 },
  { label: 'Quartic Multibrot', scene: 16 },
  { label: 'Tricorn', scene: 17 },
]

export function jumpToScene(destination: FractalZoomDestination): void {
  ;(globalThis as { beaconFractalZoomPick?: number | null }).beaconFractalZoomPick =
    destination.scene
}
