/**
 * The colours down a picture's left and right edges, each as a
 * top-to-bottom CSS gradient.
 *
 * Fanart.tv art is shown whole at a hero card's height, and on a wide card
 * most of the card is beside it. Continuing each edge across the space on
 * its side lets the picture's faded ends blend into its own colours, where
 * a blurred copy of the whole picture smears whatever reaches an edge (a
 * face, a logo) across the card.
 *
 * Most banners are a subject on a plain background. Where one clearly
 * dominates the picture's border, only pixels of that background count, so
 * a white shirt reaching the edge isn't continued as a grey streak; a band
 * with nothing but subject at the edge takes the background itself.
 *
 * Null if the image can't be loaded or read (e.g. a CORS-tainted canvas).
 */

export type Edge = 'left' | 'right'

export interface EdgeGradients {
  left: string
  right: string
}

const SAMPLE_WIDTH = 64
const SAMPLE_HEIGHT = 16
/** ~5% of the width - enough to average out a single odd pixel column,
 * narrow enough to still be the edge. */
const EDGE_COLUMNS = 3
const BANDS = 8
/** How close (RGB distance) a pixel has to be to count as the background. */
const BACKGROUND_MATCH = 48
/** Share of the border the background has to cover to be one - below
 * that, the edge is picture all the way round and is continued as is. */
const BACKGROUND_SHARE = 0.4

type Rgb = [number, number, number]

function distance(data: Uint8ClampedArray, i: number, [r, g, b]: Rgb): number {
  return Math.hypot(data[i]! - r, data[i + 1]! - g, data[i + 2]! - b)
}

/** The colour covering most of the picture's border (top and bottom rows,
 * both edges), if one covers enough of it to be a background. */
export function backgroundFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Rgb | null {
  const border: number[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onBorder = y === 0 || y === height - 1 || x < EDGE_COLUMNS || x >= width - EDGE_COLUMNS
      const i = (y * width + x) * 4
      if (onBorder && data[i + 3]! >= 128) border.push(i)
    }
  }
  if (!border.length) return null

  // The most common coarse colour, then refined to the mean of everything
  // near it.
  const buckets = new Map<number, number[]>()
  for (const i of border) {
    const key = ((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(i)
    else buckets.set(key, [i])
  }
  const largest = [...buckets.values()].reduce((a, b) => (b.length > a.length ? b : a))
  const seed = mean(data, largest)
  const matching = border.filter((i) => distance(data, i, seed) <= BACKGROUND_MATCH)
  return matching.length / border.length >= BACKGROUND_SHARE ? mean(data, matching) : null
}

function mean(data: Uint8ClampedArray, pixels: number[]): Rgb {
  let r = 0
  let g = 0
  let b = 0
  for (const i of pixels) {
    r += data[i]!
    g += data[i + 1]!
    b += data[i + 2]!
  }
  return [r / pixels.length, g / pixels.length, b / pixels.length]
}

export function edgeGradientFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  edge: Edge,
  background: Rgb | null = null,
): string | null {
  const firstColumn = edge === 'left' ? 0 : width - EDGE_COLUMNS
  const rowsPerBand = height / BANDS
  const stops: string[] = []
  for (let band = 0; band < BANDS; band++) {
    const pixels: number[] = []
    for (let y = Math.floor(band * rowsPerBand); y < Math.floor((band + 1) * rowsPerBand); y++) {
      for (let x = firstColumn; x < firstColumn + EDGE_COLUMNS; x++) {
        const i = (y * width + x) * 4
        if (data[i + 3]! < 128) continue
        if (background && distance(data, i, background) > BACKGROUND_MATCH) continue
        pixels.push(i)
      }
    }
    if (!pixels.length && !background) return null
    const [r, g, b] = pixels.length ? mean(data, pixels) : background!
    const at = (((band + 0.5) / BANDS) * 100).toFixed(1)
    stops.push(`rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}) ${at}%`)
  }
  return `linear-gradient(to bottom, ${stops.join(', ')})`
}

export async function extractEdgeGradients(url: string): Promise<EdgeGradients | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = SAMPLE_WIDTH
        canvas.height = SAMPLE_HEIGHT
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(null)
          return
        }
        ctx.drawImage(img, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
        const { data } = ctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
        const background = backgroundFromPixels(data, SAMPLE_WIDTH, SAMPLE_HEIGHT)
        const left = edgeGradientFromPixels(data, SAMPLE_WIDTH, SAMPLE_HEIGHT, 'left', background)
        const right = edgeGradientFromPixels(data, SAMPLE_WIDTH, SAMPLE_HEIGHT, 'right', background)
        resolve(left && right ? { left, right } : null)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}
