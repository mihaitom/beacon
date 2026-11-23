import { describe, expect, it } from 'vitest'
import { ORBIT_LENGTH, orbitsFor, referenceOrbits } from '../orbits'

function texel(data: Float32Array, row: number, n: number): [number, number, number] {
  const at = (row * ORBIT_LENGTH + n) * 4
  return [data[at]!, data[at + 1]!, data[at + 2]!]
}

/** The first entry whose "next one exists" flag is off. */
function end(data: Float32Array, row: number): number {
  for (let n = 0; n < ORBIT_LENGTH; n++) if (texel(data, row, n)[2] === 0) return n
  return -1
}

describe('referenceOrbits', () => {
  it('follows z -> z^2 + c from 0, one row per target', () => {
    const data = referenceOrbits([
      ['-2', '0'],
      ['0', '1'],
    ])
    expect([0, 1, 2, 3].map((n) => texel(data, 0, n))).toEqual([
      [0, 0, 1],
      [-2, 0, 1],
      [2, 0, 1],
      [2, 0, 1],
    ])
    // c = i: 0, i, -1 + i, -i, -1 + i, ...
    expect([1, 2, 3].map((n) => texel(data, 1, n).slice(0, 2))).toEqual([
      [0, 1],
      [-1, 1],
      [0, -1],
    ])
  })

  it('follows the Burning Ship where a target asks for it', () => {
    // c = -1 + i: 0, -1 + i, then (1 + i)^2 + c = -1 + 3i, where the
    // Mandelbrot set's (-1 + i)^2 + c would be -1 - i.
    const data = referenceOrbits([['-1', '1', 'burning-ship']])
    expect([1, 2].map((n) => texel(data, 0, n).slice(0, 2))).toEqual([
      [-1, 1],
      [-1, 3],
    ])
  })

  it('follows the Multibrot sets and the Tricorn where a target asks for them', () => {
    // c = i. z^3: 0, i, i - i = 0. z^4: 0, i, 1 + i. Tricorn, the
    // conjugate squared: 0, i, -1 + i, (-1 - i)^2 + i = 3i, where the
    // Mandelbrot set goes on to -i.
    const data = referenceOrbits([
      ['0', '1', 'multibrot3'],
      ['0', '1', 'multibrot4'],
      ['0', '1', 'tricorn'],
    ])
    expect(texel(data, 0, 2).slice(0, 2)).toEqual([0, 0])
    expect(texel(data, 1, 2).slice(0, 2)).toEqual([1, 1])
    expect(texel(data, 2, 3).slice(0, 2)).toEqual([0, 3])
  })

  it('ends a row where its orbit escapes or comes back to 0, and at the last entry otherwise', () => {
    // c = 1: 0, 1, 2, 5 - and 5 is out. c = -1: 0, -1, 0 - a minibrot's
    // centre, period 2. c = -2: 0, -2, 2, 2, ...
    const data = referenceOrbits([
      ['1', '0'],
      ['-1', '0'],
      ['-2', '0'],
    ])
    expect(end(data, 0)).toBe(3)
    expect(texel(data, 0, 3)[0]).toBe(5)
    expect(end(data, 1)).toBe(2)
    expect(end(data, 2)).toBe(ORBIT_LENGTH - 1)
  })

  it('counts digits no float holds', () => {
    // -2 stays on 2 for good. 1e-40 further out, the orbit's lead over 2
    // quadruples every step, and is past 2 once a float can see it, some
    // 40 steps on. A double reads both targets as -2.
    const data = referenceOrbits([
      ['-2', '0'],
      [`-2.${'0'.repeat(39)}1`, '0'],
    ])
    expect(end(data, 0)).toBe(ORBIT_LENGTH - 1)
    expect(end(data, 1)).toBeGreaterThan(35)
    expect(end(data, 1)).toBeLessThan(50)
  })

  it('refuses what is not a decimal', () => {
    expect(() => referenceOrbits([['1e-5', '0']])).toThrow()
  })
})

describe('orbitsFor', () => {
  it('works a preset out once', () => {
    const targets = [['-1', '0']] as const
    expect(orbitsFor(targets)).toBe(orbitsFor(targets))
  })
})
