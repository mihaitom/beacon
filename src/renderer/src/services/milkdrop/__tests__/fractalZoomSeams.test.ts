// How one scene of the Fractal Zoom gives way to the next. A Mandelbrot
// scene going on into another Mandelbrot scene or a Julia set ends on its
// minibrot, framed as the next scene opens on the whole set, and cuts
// there; every other scene drains away into black and the next comes up
// out of it. Runs the preset's own equations through the cut and checks
// that the frames on either side of it show the same points - whatever the
// shader does with them, a cut between two different views would show.
import { describe, expect, it } from 'vitest'
import fractalZoom from '@/assets/milkdrop/presets/beacon-fractal-zoom.json'

type Vars = Record<string, number>

const preset = fractalZoom.preset as { init_eqs_str: string; frame_eqs_str: string }
const MANDELBROT_SCENES = [0, 1, 2, 3, 4]
const RABBIT = 5
const BURNING_SHIP = 14

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

/** The fewest steps (its 2nd percentile) a scene's end view takes to
 * escape, as measured into its row of the scene table. */
function fewestSteps(scene: number): number {
  const table = preset.frame_eqs_str.match(/var S=(\[[\s\S]*?\]\]);/)![1]!
  return (JSON.parse(table) as number[][])[scene]![24]!
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
  // A Julia scene's centre is a point of the plane itself.
  return q.q5 === 1 ? [x, y] : [q.q23! + x, q.q24! + y]
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
  const SEAMS = MANDELBROT_SCENES.flatMap((scene) => [
    [scene, (scene + 1) % MANDELBROT_SCENES.length],
    [scene, RABBIT],
  ])

  it.each(SEAMS)('scene %i goes on into scene %i through its minibrot', (scene, next) => {
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

  it('opens a Julia set out of the whole set, then zooms', () => {
    const { after } = runToCut(zoom(4, RABBIT, 37))
    const step = zoom(4, RABBIT, 37)
    let q = step()
    while (!q.cut) q = step()
    expect(q.q29).toBe(0)
    let shaping = 0
    while (q.q29! < 1) {
      expect(q.D).toBe(0)
      q = step()
      shaping++
    }
    expect(after.sc).toBe(RABBIT)
    // Some seconds of it, at 60 steps a second.
    expect(shaping).toBeGreaterThan(60)
    q = step()
    expect(q.D).toBeGreaterThan(0)
  })

  it('drains away into black where the next scene is no Mandelbrot or Julia scene', () => {
    const step = zoom(0, BURNING_SHIP, 79)
    let q = step()
    let last = q.q9!
    let lowest = 1
    while (!q.cut) {
      last = q.q9!
      q = step()
      lowest = Math.min(lowest, q.fade!)
      if (!q.cut) expect(q.q9!).toBeLessThanOrEqual(last + 1e-9)
    }
    expect(lowest).toBe(1)
    expect(q.sc).toBe(BURNING_SHIP)
    // Black on both sides of the cut: before it, a limit far below the
    // fewest steps the scene's end measured; after it, a step or two,
    // which nothing in the next scene's first view escapes in.
    expect(last).toBeLessThan(fewestSteps(0) / 10)
    expect(q.q9).toBeLessThan(2)
    expect(q.q26).toBe(0)
    // And up out of it to the scene's own limit.
    let rising = q.q9!
    for (let i = 0; i < 600; i++) rising = step().q9!
    expect(rising).toBeGreaterThan(250)
  })

  it('picks the scene after next at each cut', () => {
    const { after } = runToCut(zoom(4, 0, 37))
    expect(after.nx).not.toBe(after.sc)
    expect(after.nx).toBeGreaterThanOrEqual(0)
    expect(after.nx).toBeLessThan(18)
  })
})
