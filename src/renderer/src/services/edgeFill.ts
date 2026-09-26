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
 * left edge alone, as it is - its other edges are nowhere near what's
 * continued - and only where that edge is smooth enough to extend.
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
/** The strip checked for smoothness: ~9% of the width. */
const SMOOTH_COLUMNS = 6
/** How far, on average, a band's pixels may stray from the band's mean -
 * in brightness and in colour apart, since the continued edge is each
 * band's mean: brightness detail in one colour (folds in a white dress)
 * averages out to a calm fill, while different colours (rays, skin against
 * a couch) come out as a stripe. Judged by the worst band, since one arm
 * reaching the edge is a stripe however calm the rest is. Measured on
 * cached Fanart.tv backgrounds: edges that continue well came to at most
 * brightness 34 / colour 38 (a folded dress; a soft lit edge), while an
 * arm, people or dancers at the edge came to brightness 55 and up, and
 * coloured rays to colour 110. */
const SMOOTH_BRIGHTNESS = 45
const SMOOTH_COLOUR = 60
/** Most one band's colour may jump from the next, top to bottom. Only a
 * hard line across the edge - a large but gradual change is exactly what
 * the continued gradient reproduces (the soft lit edge: 106). */
const SMOOTH_DOWN = 125
/** Most one band's brightness may step from the next. Light on a picture
 * shades gently (a folded dress: at most 30), while something reaching the
 * edge has edges of its own (an arm against a dark background: 64). */
const SMOOTH_STEP = 40
/** How far brightness has to move from its last high or low, in however
 * many bands, to count as going that way. The one turn an edge may
 * take is light rising and falling again (a folded dress, a lit edge),
 * which reads as light on the picture. Anything else comes out as a
 * stripe in the continued edge: light and dark by turns (a window frame,
 * a sign), or a darker band between lighter ones - nearly always
 * something reaching the edge, like a flower in a pattern, a face or a
 * building. */
const TURN_STEP = 12

type Rgb = [number, number, number]

function distance(data: Uint8ClampedArray, i: number, [r, g, b]: Rgb): number {
  return Math.hypot(data[i]! - r, data[i + 1]! - g, data[i + 2]! - b)
}

function brightness([r, g, b]: Rgb): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** A colour with its brightness taken out. */
function tint(colour: Rgb): Rgb {
  const y = brightness(colour)
  return [colour[0] - y, colour[1] - y, colour[2] - y]
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

/** Whether an edge is calm enough to continue: even across its strip -
 * in colour especially - and changing only gradually from top to bottom,
 * with no dark band across it and no going light and dark by turns. */
export function edgeIsSmooth(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  edge: Edge,
): boolean {
  const firstColumn = edge === 'left' ? 0 : width - SMOOTH_COLUMNS
  const rowsPerBand = height / BANDS
  const bands: Rgb[] = []
  for (let band = 0; band < BANDS; band++) {
    const pixels: number[] = []
    for (let y = Math.floor(band * rowsPerBand); y < Math.floor((band + 1) * rowsPerBand); y++) {
      for (let x = firstColumn; x < firstColumn + SMOOTH_COLUMNS; x++) {
        const i = (y * width + x) * 4
        if (data[i + 3]! >= 128) pixels.push(i)
      }
    }
    if (!pixels.length) return false
    const bandMean = mean(data, pixels)
    let brightnessStray = 0
    let colourStray = 0
    for (const i of pixels) {
      const pixel: Rgb = [data[i]!, data[i + 1]!, data[i + 2]!]
      brightnessStray += Math.abs(brightness(pixel) - brightness(bandMean))
      colourStray += Math.hypot(...tint(pixel).map((c, k) => c - tint(bandMean)[k]!))
    }
    if (brightnessStray / pixels.length > SMOOTH_BRIGHTNESS) return false
    if (colourStray / pixels.length > SMOOTH_COLOUR) return false
    const previous = bands.at(-1)
    if (previous && Math.hypot(...bandMean.map((c, k) => c - previous[k]!)) > SMOOTH_DOWN) {
      return false
    }
    if (previous && Math.abs(brightness(bandMean) - brightness(previous)) > SMOOTH_STEP) {
      return false
    }
    bands.push(bandMean)
  }
  return onlyLightRises(bands)
}

/** Whether the bands' brightness changes direction at most once, top to
 * bottom, and then from rising to falling. A move counts once it has come
 * TURN_STEP from the last high or low, so a dip taken in small steps is
 * still a dip. */
function onlyLightRises(bands: Rgb[]): boolean {
  const directions: number[] = []
  let high = brightness(bands[0]!)
  let low = high
  for (const band of bands.slice(1)) {
    const level = brightness(band)
    high = Math.max(high, level)
    low = Math.min(low, level)
    const now = level - low >= TURN_STEP ? 1 : high - level >= TURN_STEP ? -1 : 0
    if (now && now !== directions.at(-1)) {
      directions.push(now)
      high = level
      low = level
    }
  }
  // Up to one direction is a plain gradient; two are a single turn, fine
  // only as a rise then a fall.
  return directions.length <= 1 || (directions.length === 2 && directions[0] === 1)
}

/** How a picture is shown: `background-size: cover` into a box of `ratio`
 * (width / height), held at `positionY` (0 top, 1 bottom) where that crops
 * its top and bottom. */
export interface Frame {
  ratio: number
  positionY: number
}

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
function samplePixels(url: string, frame?: Frame, extent = 1): Promise<Uint8ClampedArray | null> {
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

/** A photo's left edge as it is shown in `frame`, or null where it's too
 * busy to continue. Judged over its top `extent` only, where the page fades
 * the rest out anyway - what reaches the edge down there is barely seen,
 * and holding the colour above it keeps it from streaking the fill. */
export async function extractLeftEdgeGradient(
  url: string,
  frame?: Frame,
  extent = 1,
): Promise<string | null> {
  const data = await samplePixels(url, frame, extent)
  if (!data || !edgeIsSmooth(data, SAMPLE_WIDTH, SAMPLE_HEIGHT, 'left')) return null
  return edgeGradientFromPixels(data, SAMPLE_WIDTH, SAMPLE_HEIGHT, 'left', null, extent)
}
