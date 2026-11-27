// The frame equations line the two views up (fractalZoomSeams.test.ts);
// whether the shader draws the minibrot as the whole set the next scene
// opens on only shows on a real renderer. Seahorse Valley, the shallowest
// of the Mandelbrot scenes, drawn just before its cut and just after.
import { describe, expect, it } from 'vitest'
import type { MilkdropPreset } from 'butterchurn'
import { butterchurn } from '@/services/milkdrop/butterchurn'
import fractalZoom from '@/assets/milkdrop/presets/beacon-fractal-zoom.json'
import { ORBIT_LENGTH, ORBIT_SAMPLER, orbitsFor, type OrbitTarget } from '../orbits'
import { BlaKeeper } from '../bla'
import {
  ACCENT_SAMPLER,
  COVER_SAMPLER,
  accentPicture,
  setDataTexture,
  setTexture,
} from '../textures'
import { keepLoopsRolled } from '../loops'

const W = 160
const H = 90
const SEAHORSE_VALLEY = 4
const ELEPHANT_VALLEY = 1
const file = fractalZoom as unknown as { preset: MilkdropPreset; orbits: OrbitTarget[] }
// Where its minibrot fills the view as the whole set does at the start.
const seam = () => {
  const table = (file.preset.frame_eqs_str as string).match(/var S=(\[[\s\S]*?\]\]);/)![1]!
  return -(JSON.parse(table) as number[][])[SEAHORSE_VALLEY]![18]!
}

function frameAt(depth: number): Uint8Array {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const visualizer = butterchurn.createVisualizer(new OfflineAudioContext(2, 1, 44100), canvas, {
    width: W,
    height: H,
    pixelRatio: 1,
  })
  const start = `a.sc=${SEAHORSE_VALLEY};a.nx=${ELEPHANT_VALLEY};a.D=${depth};a.fade=1;a.th=0;`
  const preset = keepLoopsRolled({
    ...file.preset,
    init_eqs_str: file.preset.init_eqs_str + start,
  })
  const orbits = orbitsFor(file.orbits)
  setDataTexture(visualizer, ORBIT_SAMPLER, orbits, ORBIT_LENGTH, file.orbits.length)
  setTexture(visualizer, ACCENT_SAMPLER, accentPicture('#3a7bd5'))
  const cover = document.createElement('canvas')
  cover.width = cover.height = 8
  const g = cover.getContext('2d')!
  g.fillStyle = '#c04a20'
  g.fillRect(0, 0, 8, 8)
  setTexture(visualizer, COVER_SAMPLER, cover)
  const bla = new BlaKeeper()
  bla.reset(visualizer, orbits)
  visualizer.loadPreset(preset, 0)
  // Silence: the zoom stands still, and a few frames settle the blend
  // with the last one.
  for (let i = 0; i < 4; i++) {
    visualizer.render()
    bla.update(visualizer)
  }
  const gl = canvas.getContext('webgl2')!
  const pixels = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  return pixels
}

function difference(a: Uint8Array, b: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i += 4) {
    sum +=
      Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!)
  }
  return sum / ((a.length / 4) * 3)
}

describe('Fractal Zoom seam', () => {
  it('draws the frame before the cut as the next scene opens', { timeout: 60_000 }, () => {
    const before = frameAt(seam() - 0.01)
    // Past the seam: the first frame cuts to the next scene.
    const after = frameAt(seam() + 0.002)
    // A view a little further out, for what a real difference measures.
    const further = frameAt(seam() - 0.6)
    const atCut = difference(before, after)
    expect(atCut).toBeLessThan(1)
    expect(difference(before, further)).toBeGreaterThan(atCut * 5)
  })
})
