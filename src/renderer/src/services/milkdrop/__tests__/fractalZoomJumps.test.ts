// The jumps name scenes by their place in the Fractal Zoom's scene
// table: when a scene is added or taken out, a jump would quietly land on
// another. Runs the preset's own equations and reads where it arrived.
import { afterEach, describe, expect, it } from 'vitest'
import fractalZoom from '@/assets/milkdrop/presets/beacon-fractal-zoom.json'
import { FRACTAL_ZOOM_DESTINATIONS, jumpToScene } from '../fractalZoomJumps'

type Vars = Record<string, number>

function zoom(): (frames: number) => Vars {
  const preset = fractalZoom.preset as { init_eqs_str: string; frame_eqs_str: string }
  const init = new Function('a', preset.init_eqs_str) as (a: Vars) => void
  const frame = new Function('a', preset.frame_eqs_str) as (a: Vars) => void
  const a: Vars = { bass: 1, mid: 1, treb: 1, bass_att: 1, mid_att: 1, treb_att: 1 }
  init(a)
  return (frames) => {
    for (let i = 0; i < frames; i++) frame(a)
    return a
  }
}

function arriveAt(label: string): Vars {
  const run = zoom()
  run(5)
  jumpToScene(FRACTAL_ZOOM_DESTINATIONS.find((entry) => entry.label === label)!)
  return run(1)
}

// 1-based into the preset's captions.
const caption = (a: Vars) => fractalZoom.captions[a.q32! - 1]!.text

describe('Fractal Zoom jumps', () => {
  afterEach(() => {
    delete (globalThis as { beaconFractalZoomPick?: unknown }).beaconFractalZoomPick
  })

  // Each scene's first caption: the Mandelbrot scenes all open on the set.
  const FIRST_CAPTIONS = [
    ...Array<string>(5).fill('Mandelbrot set'),
    'Julia set · Douady rabbit',
    'Julia set · Dendrite',
    'Julia set · Dendrite',
    'Julia set · c = −0.7269 + 0.1889i',
    'Julia set · c = −0.4 + 0.6i',
    'Julia set · c = −0.54 + 0.54i',
    'Julia set · c = −0.62 + 0.43i',
    'Julia set · Siegel disk',
    'Julia set · Basilica',
    'Burning Ship fractal',
    'Cubic Multibrot set',
    'Quartic Multibrot set',
    'Tricorn',
  ]

  it('has a jump to every scene, each landing on its own', () => {
    const scenes = FRACTAL_ZOOM_DESTINATIONS.map((to) => to.scene).sort((x, y) => x - y)
    expect(scenes).toEqual(FIRST_CAPTIONS.map((_, i) => i))
    for (const to of FRACTAL_ZOOM_DESTINATIONS) {
      const a = arriveAt(to.label)
      expect(a.sc, to.label).toBe(to.scene)
      expect(caption(a), to.label).toBe(FIRST_CAPTIONS[to.scene])
    }
  })

  it('uses a pick once, then goes back to the dice', () => {
    arriveAt(FRACTAL_ZOOM_DESTINATIONS.at(-1)!.label)
    expect((globalThis as { beaconFractalZoomPick?: unknown }).beaconFractalZoomPick).toBeNull()
  })
})
