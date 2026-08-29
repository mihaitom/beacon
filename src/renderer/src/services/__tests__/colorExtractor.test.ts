import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractDominantColor } from '../colorExtractor'

/** The extractor samples a 32x32 downscale, so a stand-in for getImageData
 * has to hand back that many pixels. `pixels` is repeated to fill it. */
function imageDataOf(pixels: [number, number, number, number][]): ImageData {
  const total = 32 * 32
  const data = new Uint8ClampedArray(total * 4)
  for (let i = 0; i < total; i++) {
    const [r, g, b, a] = pixels[i % pixels.length]!
    data.set([r, g, b, a], i * 4)
  }
  return { data, width: 32, height: 32, colorSpace: 'srgb' } as ImageData
}

type LoadOutcome = 'load' | 'error'

/** Replaces Image with one that reports `outcome` as soon as a src is set —
 * jsdom never actually fetches anything, so nothing would fire otherwise. */
function stubImage(outcome: LoadOutcome): void {
  class FakeImage {
    crossOrigin = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => (outcome === 'load' ? this.onload?.() : this.onerror?.()))
    }
  }
  vi.stubGlobal('Image', FakeImage)
}

/** Makes the sampled canvas return `data`, or throw for the CORS case. */
function stubCanvas(data: ImageData | 'throws' | 'no-context'): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    if (data === 'no-context') return null
    return {
      drawImage: () => {},
      getImageData: () => {
        if (data === 'throws') throw new Error('tainted canvas')
        return data
      },
    } as unknown as CanvasRenderingContext2D
  })
}

const GRAY: [number, number, number, number] = [128, 128, 128, 255]
const RED: [number, number, number, number] = [200, 40, 40, 255]

beforeEach(() => {
  stubImage('load')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('extractDominantColor', () => {
  it('returns the colour of a solid colourful cover', async () => {
    stubCanvas(imageDataOf([RED]))

    const rgb = await extractDominantColor('cover.jpg')

    expect(rgb).toEqual([200, 40, 40])
  })

  it('gives up on artwork with no colour in it at all', async () => {
    stubCanvas(imageDataOf([GRAY, [0, 0, 0, 255], [255, 255, 255, 255]]))

    // Fully grayscale carries no representative colour — callers are meant
    // to fall back to their own default rather than get a gray.
    expect(await extractDominantColor('gray.jpg')).toBeNull()
  })

  it('ignores near-transparent pixels', async () => {
    // A transparent green that would drag the average well off red if it
    // were counted.
    stubCanvas(imageDataOf([RED, [0, 255, 0, 10]]))

    const rgb = await extractDominantColor('cover.jpg')

    expect(rgb).toEqual([200, 40, 40])
  })

  it('favours a colourful pixel over a mass of near-white ones', async () => {
    // Nineteen near-white pixels against a single saturated red: a plain
    // average would come out almost white, which is exactly the muddy
    // result the weighting exists to avoid.
    const nearWhite: [number, number, number, number] = [250, 250, 250, 255]
    stubCanvas(imageDataOf([RED, ...Array(19).fill(nearWhite)]))

    const rgb = await extractDominantColor('cover.jpg')

    expect(rgb).not.toBeNull()
    const [r, g, b] = rgb!
    expect(r).toBeGreaterThan(g + 100)
    expect(r).toBeGreaterThan(b + 100)
  })

  it('leans toward the fuller shade over a washed-out one of the same hue', async () => {
    // Both are fully saturated reds; only their lightness differs. Half the
    // pixels each, so an unweighted average would land on g=90 — the
    // lightness term has to pull the result toward the deeper red instead,
    // which is what stops a pastel-heavy cover reading as near-white.
    stubCanvas(
      imageDataOf([
        [255, 0, 0, 255],
        [255, 180, 180, 255],
      ]),
    )

    const rgb = await extractDominantColor('pastel.jpg')

    expect(rgb).not.toBeNull()
    const [, g] = rgb!
    expect(g).toBeLessThan(75)
  })

  it('reports nothing when the image cannot be loaded', async () => {
    stubImage('error')
    stubCanvas(imageDataOf([RED]))

    expect(await extractDominantColor('missing.jpg')).toBeNull()
  })

  it('reports nothing when the canvas cannot be read', async () => {
    // A cross-origin cover taints the canvas and getImageData throws; the
    // caller should get a fallback, not an unhandled rejection.
    stubCanvas('throws')

    expect(await extractDominantColor('remote.jpg')).toBeNull()
  })

  it('reports nothing when there is no 2D context', async () => {
    stubCanvas('no-context')

    expect(await extractDominantColor('cover.jpg')).toBeNull()
  })
})
