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
      ['-1', '0'],
      ['0', '1'],
    ])
    expect([0, 1, 2, 3].map((n) => texel(data, 0, n))).toEqual([
      [0, 0, 1],
      [-1, 0, 1],
      [0, 0, 1],
      [-1, 0, 1],
    ])
    // c = i: 0, i, -1 + i, -i, -1 + i, ...
    expect([1, 2, 3].map((n) => texel(data, 1, n).slice(0, 2))).toEqual([
      [0, 1],
      [-1, 1],
      [0, -1],
    ])
  })

  it('ends a row where its orbit escapes, and at the last entry otherwise', () => {
    // c = 1: 0, 1, 2, 5 - and 5 is out.
    const data = referenceOrbits([
      ['1', '0'],
      ['-1', '0'],
    ])
    expect(end(data, 0)).toBe(3)
    expect(texel(data, 0, 3)[0]).toBe(5)
    expect(end(data, 1)).toBe(ORBIT_LENGTH - 1)
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
