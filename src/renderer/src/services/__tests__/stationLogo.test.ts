import { describe, expect, it } from 'vitest'
import { logoFill, sleeveFromPixels } from '../stationLogo'

type Pixel = [number, number, number, number]

const SIZE = 8
const CLEAR: Pixel = [0, 0, 0, 0]
const inCentre = (x: number, y: number) => x >= 2 && x < 6 && y >= 2 && y < 6

function image(pixel: (x: number, y: number) => Pixel): Uint8ClampedArray {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) data.set(pixel(x, y), (y * SIZE + x) * 4)
  }
  return data
}

describe('sleeveFromPixels', () => {
  it("continues a logo's own background", () => {
    const data = image((x, y) => (inCentre(x, y) ? [255, 255, 255, 255] : [200, 10, 20, 255]))

    expect(sleeveFromPixels(data, SIZE, SIZE)).toEqual([200, 10, 20])
  })

  it('stays neutral for a bright logo floating on transparency', () => {
    const data = image((x, y) => (inCentre(x, y) ? [240, 240, 240, 255] : CLEAR))

    expect(sleeveFromPixels(data, SIZE, SIZE)).toBeNull()
  })

  it('lights the sleeve for a dark logo that would vanish on the neutral one', () => {
    const data = image((x, y) => (inCentre(x, y) ? [10, 10, 10, 255] : CLEAR))

    const sleeve = sleeveFromPixels(data, SIZE, SIZE)

    expect(sleeve).not.toBeNull()
    expect(Math.min(...sleeve!)).toBeGreaterThan(200)
  })

  it('lights the sleeve for a logo with a large dark part beside a coloured one', () => {
    const data = image((x, y) => {
      if (!inCentre(x, y)) return CLEAR
      return x < 4 ? [30, 40, 70, 255] : [240, 165, 0, 255]
    })

    expect(sleeveFromPixels(data, SIZE, SIZE)).not.toBeNull()
  })

  it('stays neutral for a colourful logo with only a thin dark outline', () => {
    const data = image((x, y) => {
      if (!inCentre(x, y)) return CLEAR
      return x === 2 && y === 2 ? [10, 10, 10, 255] : [240, 165, 0, 255]
    })

    expect(sleeveFromPixels(data, SIZE, SIZE)).toBeNull()
  })

  it('stays neutral for a logo with no dark part at all', () => {
    const data = image((x, y) => (inCentre(x, y) ? [240, 165, 0, 255] : CLEAR))

    expect(sleeveFromPixels(data, SIZE, SIZE)).toBeNull()
  })

  it('leaves a dark logo with light lettering on the dark sleeve it was made for', () => {
    const data = image((x, y) => {
      if (!inCentre(x, y)) return CLEAR
      return y === 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]
    })

    expect(sleeveFromPixels(data, SIZE, SIZE)).toBeNull()
  })

  it('stays neutral for a fully transparent image', () => {
    expect(
      sleeveFromPixels(
        image(() => CLEAR),
        SIZE,
        SIZE,
      ),
    ).toBeNull()
  })

  it('stays neutral when the border has no one colour to continue', () => {
    const colours: Pixel[] = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 0, 255],
    ]
    const data = image((x, y) => colours[(x + y) % colours.length]!)

    expect(sleeveFromPixels(data, SIZE, SIZE)).toBeNull()
  })
})

describe('logoFill', () => {
  const SOLID: Pixel = [10, 10, 10, 255]

  it('is whole for an image with no transparent margin', () => {
    expect(
      logoFill(
        image(() => SOLID),
        SIZE,
        SIZE,
      ),
    ).toBe(1)
  })

  it('measures the margin around the logo', () => {
    const data = image((x, y) => (x >= 1 && x < 7 && y >= 3 && y < 5 ? SOLID : CLEAR))

    expect(logoFill(data, SIZE, SIZE)).toBe(0.75)
  })

  it('goes by the longer side of the logo', () => {
    const data = image((x, y) => (x === 3 && y >= 1 && y < 7 ? SOLID : CLEAR))

    expect(logoFill(data, SIZE, SIZE)).toBe(0.75)
  })

  it('does not blow up a stray speck', () => {
    const data = image((x, y) => (x === 3 && y === 3 ? SOLID : CLEAR))

    expect(logoFill(data, SIZE, SIZE)).toBe(0.5)
  })

  it('leaves a fully transparent image alone', () => {
    expect(
      logoFill(
        image(() => CLEAR),
        SIZE,
        SIZE,
      ),
    ).toBe(1)
  })
})
