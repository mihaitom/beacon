import type { MilkdropVisualizer } from 'butterchurn'
import { lastFrame } from '@/services/milkdrop/captions'
import { ORBIT_LENGTH } from '@/services/milkdrop/orbits'
import { setDataTexture } from '@/services/milkdrop/textures'

/** Skipping ahead on a Mandelbrot target's orbit (bilinear approximation).
 * A pixel follows its difference d from the target's orbit Z, one step at
 * a time: d -> 2Zd + d^2 + dc. While d is far smaller than Z, the d^2 is
 * lost in a float's rounding anyway, and what is left is linear - so many
 * steps fold into one: d -> A d + B dc. Deep in, where a pixel spends
 * most of its steps close to the target, that saves most of them.
 *
 * The table holds, for every stretch of 2^k steps starting at entry
 * 1 + j * 2^k (k from 1), its A and B and how small d has to be for it to
 * hold (R). R depends on how large dc can be, so a table is only good for
 * a view no larger than the one it was built for: build it again as the
 * zoom moves on (`needsRebuild`), and the shader checks each pixel's own
 * dc against the one in the table. */

export const BLA_SAMPLER = 'bla'

/** Each stretch: (A, B) in one texel, (R) in the next. Below the first
 * row, which holds what the table was built for. */
export const BLA_WIDTH = ORBIT_LENGTH
const LEVELS = Math.log2(ORBIT_LENGTH) - 1
const STRETCHES = ORBIT_LENGTH - 2
export const BLA_HEIGHT = 1 + Math.ceil((STRETCHES * 2) / BLA_WIDTH)

/** The share of Z that d may reach for a step to count as linear: what a
 * float's 24 bits of digits cannot tell from it. */
const LINEAR = 2 ** -24

/** The texel holding (A, B) of the level's stretch from orbit entry
 * `start` (1 + j * 2^level); R is in the next. Level 1 first, each level's
 * stretches in a run. The shader works out the same. */
export function stretchTexel(level: number, start: number): number {
  const before = ORBIT_LENGTH - (ORBIT_LENGTH >> (level - 1))
  return BLA_WIDTH + 2 * (before + ((start - 1) >> level))
}

export interface BlaTable {
  /** The target's place among the preset's orbits, as the shader's q21. */
  target: number
  /** The largest |dc| it holds for. */
  dcMax: number
  data: Float32Array
}

/** A table that holds for nothing: before the first is built, the shader
 * must not read a stale one or an empty texture as a table. */
export function emptyBla(): Float32Array {
  const data = new Float32Array(BLA_WIDTH * BLA_HEIGHT * 4)
  data[0] = -1
  return data
}

/** The table for target `target` of `orbits` (as orbits.ts lays them
 * out), for views where |dc| stays below dcMax. */
export function buildBla(orbits: Float32Array, target: number, dcMax: number): BlaTable {
  const data = new Float32Array(BLA_WIDTH * BLA_HEIGHT * 4)
  data[0] = target
  data[1] = dcMax
  const at = (n: number) => (target * ORBIT_LENGTH + n) * 4
  // Steps exist from entry 1 up to the last before the orbit ends.
  let end = 1
  while (end < ORBIT_LENGTH - 1 && orbits[at(end) + 2] === 1) end++

  // Level 0, one step from entry n: A = 2Z, B = 1.
  let ar = new Float64Array(ORBIT_LENGTH)
  let ai = new Float64Array(ORBIT_LENGTH)
  let br = new Float64Array(ORBIT_LENGTH)
  let bi = new Float64Array(ORBIT_LENGTH)
  let r = new Float64Array(ORBIT_LENGTH)
  for (let n = 1; n < end; n++) {
    const x = orbits[at(n)]!
    const y = orbits[at(n) + 1]!
    ar[n] = 2 * x
    ai[n] = 2 * y
    br[n] = 1
    r[n] = LINEAR * Math.hypot(ar[n]!, ai[n]!)
  }

  let width = 1
  for (let level = 1; level <= LEVELS; level++) {
    const half = width
    width *= 2
    const next = {
      ar: new Float64Array(ORBIT_LENGTH),
      ai: new Float64Array(ORBIT_LENGTH),
      br: new Float64Array(ORBIT_LENGTH),
      bi: new Float64Array(ORBIT_LENGTH),
      r: new Float64Array(ORBIT_LENGTH),
    }
    for (let j = 0; 1 + j * width < ORBIT_LENGTH; j++) {
      const x = 1 + j * width
      const y = x + half
      let radius = 0
      if (y + half <= end) {
        // x first, then y: d -> Ay (Ax d + Bx dc) + By dc.
        const xr = ar[x]!
        const xi = ai[x]!
        const yr = ar[y]!
        const yi = ai[y]!
        next.ar[x] = yr * xr - yi * xi
        next.ai[x] = yr * xi + yi * xr
        next.br[x] = yr * br[x]! - yi * bi[x]! + br[y]!
        next.bi[x] = yr * bi[x]! + yi * br[x]! + bi[y]!
        // d must stay inside x's radius, and what x makes of it inside y's.
        const ax = Math.hypot(xr, xi)
        const bx = Math.hypot(br[x]!, bi[x]!)
        radius = Math.max(0, Math.min(r[x]!, (r[y]! - bx * dcMax) / ax))
        if (!Number.isFinite(radius)) radius = 0
      }
      next.r[x] = radius
      const texel = stretchTexel(level, x)
      data[texel * 4] = next.ar[x]!
      data[texel * 4 + 1] = next.ai[x]!
      data[texel * 4 + 2] = next.br[x]!
      data[texel * 4 + 3] = next.bi[x]!
      // Past a float's range the stretch is of no use anyway.
      const stored = Math.fround(radius)
      data[(texel + 1) * 4] = Number.isFinite(stored) ? stored : 0
    }
    ar = next.ar
    ai = next.ai
    br = next.br
    bi = next.bi
    r = next.r
  }
  return { target, dcMax, data }
}

/** Whether the view now needs another table: a different target, a view
 * larger than the table holds for, or one so much smaller that a new
 * table would let pixels skip further. */
export function needsRebuild(table: BlaTable | null, target: number, dcMax: number): boolean {
  if (!table || table.target !== target) return true
  return table.dcMax < dcMax || table.dcMax > 2 * dcMax
}

/** How far from the screen's centre a pixel's dc reaches, in heights of
 * the view: half the diagonal of a screen up to 21:9, with room for the
 * shader's |x| + |y|, which reads up to 1.42 times |dc|. A pixel beyond
 * it is still drawn, only without skipping. */
const VIEW_REACH = 2.2

/** Keeps the table in step with the view of the preset on screen: after
 * each frame, from what the preset reported in it - the Fractal Zoom's
 * kind (q5), power (q25), conjugate (q22), target (q21), view height (q3)
 * and its centre's offset from the target (q1, q2). Only the Mandelbrot
 * set itself has a table. */
export class BlaKeeper {
  private orbits: Float32Array | null = null
  private table: BlaTable | null = null

  /** A new preset: its orbits, or null for one without. */
  reset(visualizer: MilkdropVisualizer, orbits: Float32Array | null): void {
    this.orbits = orbits
    this.table = null
    if (orbits) setDataTexture(visualizer, BLA_SAMPLER, emptyBla(), BLA_WIDTH, BLA_HEIGHT)
  }

  update(visualizer: MilkdropVisualizer): void {
    if (!this.orbits) return
    const q = (name: string) => lastFrame(visualizer, name)
    if (q('q5') !== 0 || q('q25') !== 2 || q('q22') !== 0) return
    const target = q('q21')
    const height = q('q3')
    const x = q('q1')
    const y = q('q2')
    if (target === null || height === null || x === null || y === null) return
    const dcMax = Math.hypot(x, y) + height * VIEW_REACH
    if (!needsRebuild(this.table, target, dcMax)) return
    this.table = buildBla(this.orbits, target, dcMax)
    setDataTexture(visualizer, BLA_SAMPLER, this.table.data, BLA_WIDTH, BLA_HEIGHT)
  }
}
