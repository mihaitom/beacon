import { describe, expect, it } from 'vitest'
import {
  backgroundFromPixels,
  edgeColourFromPixels,
  edgeGradientFromPixels,
  leftEdgeFillFromPixels,
  visibleRect,
} from '../edgeFill'

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

  it('ends at `extent`, leaving its last colour to carry on below', () => {
    const data = image(64, 16, () => [10, 20, 30, 255])

    const gradient = edgeGradientFromPixels(data, 64, 16, 'left', null, 0.75)!

    expect(gradient).toMatch(/rgb\(10, 20, 30\) 70\.3%\)$/)
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

describe('edgeColourFromPixels', () => {
  it('takes the colour most of the edge is, not an average with the lettering across it', () => {
    // A blue backdrop with a band of white lettering reaching the edge; the
    // picture beside the edge is red.
    const data = image(64, 16, (x, y) => {
      if (x >= 3) return [255, 0, 0, 255]
      return y >= 4 && y < 8 ? [240, 240, 240, 255] : [20, 60, 180, 255]
    })

    expect(edgeColourFromPixels(data, 64, 16, 'left')).toBe('rgb(20, 60, 180)')
  })
})

describe('leftEdgeFillFromPixels', () => {
  it("continues a photo's background past a sleeve that fills its edge", () => {
    // A white studio backdrop all round, and a black sleeve covering most
    // of the left edge - more of the edge than the backdrop does.
    const data = image(64, 16, (x, y) =>
      x < 8 && y >= 3 && y < 15 ? [10, 10, 10, 255] : [245, 245, 245, 255],
    )

    const fill = leftEdgeFillFromPixels(data, 64, 16)

    expect(fill?.flat).toBe('rgb(245, 245, 245)')
    expect(fill?.gradient).not.toContain('rgb(10, 10, 10)')
  })

  it("takes the edge's main colour where the photo has no one background", () => {
    const data = image(64, 16, (x) => (x < 3 ? [20, 60, 180, 255] : [(x * 37) % 256, 90, 40, 255]))

    expect(leftEdgeFillFromPixels(data, 64, 16)?.flat).toBe('rgb(20, 60, 180)')
  })
})

describe('visibleRect', () => {
  it('is the whole picture when it is shown at its own shape', () => {
    expect(visibleRect(1920, 1080, { ratio: 16 / 9, positionY: 0.5 })).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    })
  })

  it('crops top and bottom for a wider frame, held where the frame holds it', () => {
    // 1920 wide at 2.4:1 is 800 of the 1080 rows; a quarter of the 280 cut
    // comes off the top.
    expect(visibleRect(1920, 1080, { ratio: 2.4, positionY: 0.25 })).toEqual({
      x: 0,
      y: 70,
      width: 1920,
      height: 800,
    })
  })

  it('crops both sides evenly for a narrower frame', () => {
    expect(visibleRect(1920, 1080, { ratio: 1, positionY: 0.25 })).toEqual({
      x: 420,
      y: 0,
      width: 1080,
      height: 1080,
    })
  })
})
