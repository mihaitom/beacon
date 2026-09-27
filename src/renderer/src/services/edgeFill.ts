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
 * A photo shown at the right (DetailPageBackdrop.vue) is continued from its
 * left edge alone - its right edge is nowhere near what's continued - and
 * settles into a single colour away from it.
 *
 * Null if the image can't be loaded or read (e.g. a CORS-tainted canvas).
 */

export type Edge = 'left' | 'right'

export interface EdgeGradients {
  left: string
  right: string
}

export const SAMPLE_WIDTH = 64
export const SAMPLE_HEIGHT = 16
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
  const { colour, share } = dominantColour(data, border)
  return share >= BACKGROUND_SHARE ? colour : null
}

/** The colour most of `pixels` are: the most common coarse colour, refined
 * to the mean of everything near it, and the share of `pixels` that is. */
function dominantColour(data: Uint8ClampedArray, pixels: number[]): { colour: Rgb; share: number } {
  const buckets = new Map<number, number[]>()
  for (const i of pixels) {
    const key = ((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(i)
    else buckets.set(key, [i])
  }
  const largest = [...buckets.values()].reduce((a, b) => (b.length > a.length ? b : a))
  const seed = mean(data, largest)
  const matching = pixels.filter((i) => distance(data, i, seed) <= BACKGROUND_MATCH)
  return { colour: mean(data, matching), share: matching.length / pixels.length }
}

function css([r, g, b]: Rgb): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`
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
  /** How much of the picture's height `data` is, from the top - the
   * gradient's last colour then carries on down the rest. */
  extent = 1,
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
    const at = (((band + 0.5) / BANDS) * 100 * extent).toFixed(1)
    stops.push(`rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}) ${at}%`)
  }
  return `linear-gradient(to bottom, ${stops.join(', ')})`
}

/** How a picture is shown: `background-size: cover` into a box of `ratio`
 * (width / height), held at `positionY` (0 top, 1 bottom) where that crops
 * its top and bottom. */
export interface Frame {
  ratio: number
  positionY: number
}

/** How DetailPageBackdrop.vue frames a photo - kept in step with its
 * `--art-ratio` and background-position - on a detail page and on the album
 * page's shallower band. Here rather than in the component so that
 * scripts/edge-fill/ samples photos exactly as the page does. */
export const PHOTO_FRAME: Frame = { ratio: 16 / 9, positionY: 0.5 }
export const BANDED_PHOTO_FRAME: Frame = { ratio: 2.4, positionY: 0.25 }
/** How much of the photo, from the top, its edge is read from: below 75%
 * the band's fade to the page has it under ~40% on both arrangements. */
export const EDGE_EXTENT = 0.75

/** The part of a `width` x `height` picture a frame shows, as a source
 * rectangle - what is on screen is what has to be continued. */
export function visibleRect(width: number, height: number, frame?: Frame) {
  if (!frame) return { x: 0, y: 0, width, height }
  if (width / height > frame.ratio) {
    const shown = height * frame.ratio
    return { x: (width - shown) / 2, y: 0, width: shown, height }
  }
  const shown = width / frame.ratio
  return { x: 0, y: (height - shown) * frame.positionY, width, height: shown }
}

/** The shown part of the picture (its top `extent` of that), downscaled to
 * the sampling size, or null if it can't be loaded or read. */
export function samplePixels(
  url: string,
  frame?: Frame,
  extent = 1,
): Promise<Uint8ClampedArray | null> {
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
        const shown = visibleRect(img.naturalWidth, img.naturalHeight, frame)
        ctx.drawImage(
          img,
          shown.x,
          shown.y,
          shown.width,
          shown.height * extent,
          0,
          0,
          SAMPLE_WIDTH,
          SAMPLE_HEIGHT,
        )
        resolve(ctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/** Both edges of a banner, drawn from its background where it has one. */
export async function extractEdgeGradients(url: string): Promise<EdgeGradients | null> {
  const data = await samplePixels(url)
  if (!data) return null
  const background = backgroundFromPixels(data, SAMPLE_WIDTH, SAMPLE_HEIGHT)
  const left = edgeGradientFromPixels(data, SAMPLE_WIDTH, SAMPLE_HEIGHT, 'left', background)
  const right = edgeGradientFromPixels(data, SAMPLE_WIDTH, SAMPLE_HEIGHT, 'right', background)
  return left && right ? { left, right } : null
}

/** A photo's continued left edge: the edge itself, top to bottom, and its
 * main colour, which the page fades it into away from the photo. */
export interface LeftEdgeFill {
  gradient: string
  flat: string
}

/** The main colour of an edge's continued columns - the one most of them
 * are, not their average: a blue backdrop with white lettering reaching the
 * edge is blue, where the average is a grey that is nowhere in the photo. */
export function edgeColourFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  edge: Edge,
): string {
  const firstColumn = edge === 'left' ? 0 : width - EDGE_COLUMNS
  const pixels: number[] = []
  for (let y = 0; y < height; y++) {
    for (let x = firstColumn; x < firstColumn + EDGE_COLUMNS; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3]! >= 128) pixels.push(i)
    }
  }
  return css(pixels.length ? dominantColour(data, pixels).colour : [0, 0, 0])
}

/** A photo's left edge, continued: drawn from the photo's background where
 * it has one, as a banner's is, so a sleeve or a sign reaching the edge is
 * left out of it - and fading, away from the photo, into that background
 * or else the edge's main colour. Once it settles into one colour, any edge
 * reads as part of the picture, so there is nothing left to judge. */
export function leftEdgeFillFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  extent = 1,
): LeftEdgeFill | null {
  const background = backgroundFromPixels(data, width, height)
  const gradient = edgeGradientFromPixels(data, width, height, 'left', background, extent)
  if (!gradient) return null
  const flat = background ? css(background) : edgeColourFromPixels(data, width, height, 'left')
  return { gradient, flat }
}

/** A photo's continued left edge as it is shown in `frame`, or null if it
 * can't be read. Read over its top `extent` only, where the page fades the
 * rest out anyway - what reaches the edge down there is barely seen. */
export async function extractLeftEdgeFill(
  url: string,
  frame?: Frame,
  extent = 1,
): Promise<LeftEdgeFill | null> {
  const data = await samplePixels(url, frame, extent)
  return data ? leftEdgeFillFromPixels(data, SAMPLE_WIDTH, SAMPLE_HEIGHT, extent) : null
}
