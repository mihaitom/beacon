import { describe, expect, it } from 'vitest'
import { backgroundFromPixels, edgeGradientFromPixels } from '../edgeFill'

type Pixel = [number, number, number, number]

/** A width x height image whose pixel at (x, y) is `paint(x, y)`. */
function image(width: number, height: number, paint: (x: number, y: number) => Pixel) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4)
  }
  return data
}

describe('edgeGradientFromPixels', () => {
  it('takes the colours of the left edge, not of the rest of the picture', () => {
    const data = image(64, 16, (x) => (x < 3 ? [10, 20, 30, 255] : [250, 0, 0, 255]))

    const gradient = edgeGradientFromPixels(data, 64, 16, 'left')!

    expect(gradient).toContain('rgb(10, 20, 30)')
    expect(gradient).not.toContain('250')
  })

  it('reads the right edge from the rightmost columns', () => {
    const data = image(64, 16, (x) => (x >= 61 ? [10, 20, 30, 255] : [250, 0, 0, 255]))

    const gradient = edgeGradientFromPixels(data, 64, 16, 'right')!

    expect(gradient).toContain('rgb(10, 20, 30)')
    expect(gradient).not.toContain('250')
  })

  it('keeps the edge colours in their top-to-bottom order', () => {
    const data = image(64, 16, (_x, y) => (y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]))

    const gradient = edgeGradientFromPixels(data, 64, 16, 'left')!

    expect(gradient.startsWith('linear-gradient(to bottom, rgb(255, 255, 255)')).toBe(true)
    expect(gradient).toMatch(/rgb\(0, 0, 0\) [\d.]+%\)$/)
  })

  it('ignores transparent pixels, and gives up on an edge with nothing opaque', () => {
    const partly = image(64, 16, (x) => (x === 0 ? [255, 0, 0, 0] : [0, 0, 255, 255]))
    expect(edgeGradientFromPixels(partly, 64, 16, 'left')).not.toContain('255, 0, 0')

    const clear = image(64, 16, () => [255, 0, 0, 0])
    expect(edgeGradientFromPixels(clear, 64, 16, 'left')).toBeNull()
  })
})

describe('backgroundFromPixels', () => {
  it('finds the plain colour most of the border is', () => {
    // Black, with a white subject reaching the left edge mid-height.
    const data = image(64, 16, (x, y) =>
      x < 12 && y >= 4 && y < 12 ? [250, 250, 250, 255] : [5, 5, 5, 255],
    )

    expect(backgroundFromPixels(data, 64, 16)).toEqual([5, 5, 5])
  })

  it('finds none where no one colour covers enough of the border', () => {
    // A different colour every few columns, as in a photo edge to edge.
    const data = image(64, 16, (x, y) => [(x * 37) % 256, (y * 53) % 256, (x * y * 11) % 256, 255])

    expect(backgroundFromPixels(data, 64, 16)).toBeNull()
  })
})

describe('edgeGradientFromPixels on a plain background', () => {
  it('leaves a subject reaching the edge out of the edge colour', () => {
    const data = image(64, 16, (x, y) =>
      x < 12 && y >= 4 && y < 12 ? [250, 250, 250, 255] : [5, 5, 5, 255],
    )
    const background = backgroundFromPixels(data, 64, 16)

    const gradient = edgeGradientFromPixels(data, 64, 16, 'left', background)!

    expect(gradient).not.toMatch(/rgb\((?:[5-9]\d|\d{3}),/)
    expect(gradient.match(/rgb\(5, 5, 5\)/g)).toHaveLength(8)
  })

  it('still follows the background as it shades from top to bottom', () => {
    // A background darkening from 40 to 25 downwards, subject at the left
    // edge mid-height.
    const data = image(64, 16, (x, y) =>
      x < 12 && y >= 6 && y < 10 ? [250, 250, 250, 255] : [40 - y, 40 - y, 40 - y, 255],
    )
    const background = backgroundFromPixels(data, 64, 16)

    const gradient = edgeGradientFromPixels(data, 64, 16, 'left', background)!

    expect(gradient.startsWith('linear-gradient(to bottom, rgb(40, 40, 40)')).toBe(true)
    expect(gradient).toMatch(/rgb\(26, 26, 26\) [\d.]+%\)$/)
    expect(gradient).not.toContain('250')
  })
})
