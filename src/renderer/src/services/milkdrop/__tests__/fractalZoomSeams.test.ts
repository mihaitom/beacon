// A Mandelbrot scene that goes on into another ends on its minibrot,
// framed as the next scene opens on the whole set, and cuts there. Runs
// the preset's own equations up to the cut and checks that the frames on
// either side of it show the same points - whatever the shader does with
// them, a cut between two different views would show.
import { describe, expect, it } from 'vitest'
import fractalZoom from '@/assets/milkdrop/presets/beacon-fractal-zoom.json'

type Vars = Record<string, number>

const preset = fractalZoom.preset as { init_eqs_str: string; frame_eqs_str: string }
const MANDELBROT_SCENES = [0, 1, 2, 3, 4]
// The Douady rabbit, a Julia set: nothing to go on into.
const JULIA_SCENE = 5

function zoom(scene: number, next: number, depth: number): () => Vars {
  const init = new Function('a', preset.init_eqs_str) as (a: Vars) => void
  const frame = new Function('a', preset.frame_eqs_str) as (a: Vars) => void
  // Loud, so the zoom moves at its fastest.
  const a: Vars = { bass: 1, mid: 1, treb: 1, bass_att: 2.5, mid_att: 2.5, treb_att: 2.5 }
  init(a)
  Object.assign(a, { sc: scene, nx: next, D: depth, fade: 1, e: 2.5 })
  return () => {
    frame(a)
    return { ...a }
  }
}

type C = [number, number]
const mul = ([a, b]: C, [c, d]: C): C => [a * c - b * d, a * d + b * c]
const turn = ([x, y]: C, angle: number): C => mul([x, y], [Math.cos(angle), Math.sin(angle)])

/** Where screen point `s` sits in the frame's own plane, as an offset
 * from its target - the shader's p. */
function offsetAt(q: Vars, s: C): C {
  const [x, y] = turn(s, q.q4!)
  return [q.q1! + x * q.q3!, q.q2! + y * q.q3!]
}

/** The point of the whole set screen point `s` shows: through the
 * minibrot before the cut, the set itself after it. */
function wholeSetBefore(q: Vars, s: C): C {
  return mul(offsetAt(q, s), [q.q27!, q.q28!])
}
function wholeSetAfter(q: Vars, s: C): C {
  const [x, y] = offsetAt(q, s)
  return [q.q23! + x, q.q24! + y]
}

function runToCut(step: () => Vars): { before: Vars; after: Vars } {
  let before = step()
  for (let i = 0; i < 2000; i++) {
    const after = step()
    if (after.cut) return { before, after }
    before = after
  }
  throw new Error('No cut')
}

describe('Fractal Zoom seams', () => {
  it.each(MANDELBROT_SCENES)('scene %i goes on into the next through its minibrot', (scene) => {
    const next = (scene + 1) % MANDELBROT_SCENES.length
    const step = zoom(scene, next, 30)
    let lowest = 1
    let earlier = step()
    let before = step()
    let after = step()
    for (let i = 0; i < 20000 && !after.cut; i++) {
      ;[earlier, before, after] = [before, after, step()]
      lowest = Math.min(lowest, after.fade!)
    }
    expect(after.sc).toBe(next)
    // Straight on, no fade to black.
    expect(lowest).toBe(1)
    // Blended all but the last frame's step over into the whole set.
    expect(before.q26).toBeGreaterThan(0.99)
    for (const s of [
      [0, 0],
      [0.5, 0.3],
      [-0.8, -0.45],
    ] as C[]) {
      const [x0, y0] = wholeSetBefore(earlier, s)
      const [x1, y1] = wholeSetBefore(before, s)
      const [x2, y2] = wholeSetAfter(after, s)
      // The cut moves the picture no further than a frame of zoom does.
      const frameStep = Math.hypot(x1 - x0, y1 - y0)
      expect(frameStep).toBeGreaterThan(0)
      expect(Math.hypot(x2 - x1, y2 - y1)).toBeLessThan(frameStep * 1.5)
    }
  })

  it('fades out as before where the next scene is not a Mandelbrot scene', () => {
    const { after } = runToCut(zoom(0, JULIA_SCENE, 79))
    expect(after.q12).toBe(0)
    expect(after.sc).toBe(JULIA_SCENE)
    expect(after.q26).toBe(0)
  })

  it('picks the scene after next at each cut', () => {
    const { after } = runToCut(zoom(4, 0, 37))
    expect(after.nx).not.toBe(after.sc)
    expect(after.nx).toBeGreaterThanOrEqual(0)
    expect(after.nx).toBeLessThan(18)
  })
})
