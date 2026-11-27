import { describe, expect, it } from 'vitest'
import { buildBla, needsRebuild, stretchTexel } from '../bla'
import { referenceOrbits } from '../orbits'

// A minibrot of period 98, some 2^-80 across - one of the Fractal Zoom's.
const TARGET = [
  '-0.10109636384548814359239803201597530192122765707637573106031467',
  '0.95628651080938240717319231540628902915129427211957638233390052',
] as const
const orbits = referenceOrbits([TARGET])
const Z = (n: number): [number, number] => [orbits[n * 4]!, orbits[n * 4 + 1]!]

type C = [number, number]
const mul = ([a, b]: C, [c, d]: C): C => [a * c - b * d, a * d + b * c]
const add = ([a, b]: C, [c, d]: C): C => [a + c, b + d]

/** Step by step, d^2 and all. */
function stepwise(d: C, dc: C, from: number, steps: number): C {
  for (let n = from; n < from + steps; n++) {
    const z = Z(n)
    d = add(add(mul([2 * z[0], 2 * z[1]], d), mul(d, d)), dc)
  }
  return d
}

function stretch(data: Float32Array, level: number, start: number) {
  const at = stretchTexel(level, start) * 4
  return {
    a: [data[at]!, data[at + 1]!] as C,
    b: [data[at + 2]!, data[at + 3]!] as C,
    radius: data[at + 4]!,
  }
}

describe('buildBla', () => {
  const dcMax = 2 ** -60
  const table = buildBla(orbits, 0, dcMax)

  it('folds a stretch of steps into one that lands where they do', () => {
    const dc: C = [dcMax * 0.6, -dcMax * 0.7]
    let checked = 0
    for (const level of [2, 3, 6, 9]) {
      for (const start of [1, 1 + (1 << level), 1 + 3 * (1 << level)]) {
        const { a, b, radius } = stretch(table.data, level, start)
        if (radius <= 0) continue
        const d: C = [radius * 0.5, radius * 0.4]
        const folded = add(mul(a, d), mul(b, dc))
        const exact = stepwise(d, dc, start, 1 << level)
        const size = Math.hypot(...exact)
        expect(Math.hypot(folded[0] - exact[0], folded[1] - exact[1]) / size).toBeLessThan(1e-4)
        checked++
      }
    }
    // Most of these hold for something: otherwise nothing was checked.
    expect(checked).toBeGreaterThan(4)
  })

  it('holds for nothing across the minibrot, where Z comes back near 0', () => {
    // A stretch over the whole period would pass Z_98, back at 0, where
    // the orbit ends: the pixel starts over there instead.
    expect(stretch(table.data, 7, 1).radius).toBe(0)
  })

  it('holds for less the wider the view it was built for', () => {
    const wide = buildBla(orbits, 0, 2 ** -40)
    expect(stretch(wide.data, 5, 1).radius).toBeLessThan(stretch(table.data, 5, 1).radius)
  })

  it('names what it was built for in its first texel, for the shader to check', () => {
    expect([table.data[0], table.data[1]]).toEqual([0, Math.fround(dcMax)])
  })

  it('ends where the orbit ends', () => {
    // c = 1: 0, 1, 2, then 5 is out. Steps from 1 and 2 reach the orbit's
    // last point, a stretch of four would run past it.
    const short = buildBla(referenceOrbits([['1', '0']]), 0, 1e-10)
    expect(stretch(short.data, 1, 1).radius).toBeGreaterThan(0)
    expect(stretch(short.data, 2, 1).radius).toBe(0)
  })
})

describe('needsRebuild', () => {
  const table = buildBla(orbits, 0, 1e-20)

  it('builds the first, and again for another target', () => {
    expect(needsRebuild(null, 0, 1e-20)).toBe(true)
    expect(needsRebuild(table, 1, 1e-20)).toBe(true)
  })

  it('keeps a table while the view stays inside it, until it has halved', () => {
    expect(needsRebuild(table, 0, 0.8e-20)).toBe(false)
    expect(needsRebuild(table, 0, 0.4e-20)).toBe(true)
  })

  it('never keeps one too small for the view', () => {
    expect(needsRebuild(table, 0, 1.1e-20)).toBe(true)
  })
})
