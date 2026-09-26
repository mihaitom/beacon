import { describe, expect, it } from 'vitest'
import { personShare } from '../personAtEdge'

/** A `width` x `height` confidence mask, person where `isPerson(x, y)`. */
function mask(width: number, height: number, isPerson: (x: number, y: number) => boolean) {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = isPerson(x, y) ? 0.9 : 0.1
  }
  return data
}

describe('personShare', () => {
  const whole = { x: 0, y: 0, width: 100, height: 100 }

  it('counts only the strip along the left edge', () => {
    // A person filling the right half, nowhere near the edge.
    const data = mask(100, 100, (x) => x >= 50)

    expect(personShare(data, 100, 100, whole)).toBe(0)
  })

  it('is the share of that strip a person covers', () => {
    // An arm across the strip over a quarter of the height.
    const data = mask(100, 100, (x, y) => x < 30 && y >= 50 && y < 75)

    expect(personShare(data, 100, 100, whole)).toBeCloseTo(0.25)
  })

  it('judges only the shown part of the picture', () => {
    // Someone at the edge in the bottom rows a frame crops away.
    const data = mask(100, 100, (x, y) => x < 30 && y >= 80)

    expect(personShare(data, 100, 100, { x: 0, y: 0, width: 100, height: 75 })).toBe(0)
  })
})
