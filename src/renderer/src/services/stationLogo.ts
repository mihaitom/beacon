import { backgroundFromPixels } from '@/services/edgeFill'

type Rgb = [number, number, number]

/** What a station's logo needs from the sleeve it stands on. */
export interface LogoLook {
  /** The sleeve's colour; null if the logo does not call for one. */
  sleeve: Rgb | null
  /** The logo's longer side in pixels; 0 if it has none of its own (SVG). */
  pixels: number
  /** How much of the image's longer side the logo itself takes up. */
  fill: number
}

const SAMPLE_SIZE = 32
const OPAQUE_ALPHA = 128
// Below this share of opaque border pixels the logo floats on transparency
// and has no background of its own to continue.
const SOLID_BORDER_SHARE = 0.9
// Brightness (0-255) under which a floating logo's pixels vanish into a dark
// sleeve, and the share of them it takes for that to cost the logo a part
// that matters. Well above a mere dark outline.
const DARK_PIXEL = 64
const MIN_DARK_SHARE = 0.25
// Above this share of light pixels a logo has lettering or an outline meant
// for a dark page, which a light sleeve would swallow.
const LIGHT_PIXEL = 180
const MAX_LIGHT_SHARE = 0.03
const LIGHT_SLEEVE: Rgb = [232, 232, 236]
// A sparser reading than this is a stray speck or two, not a logo's extent.
const MIN_FILL = 0.5

/** The sleeve colour for a logo's pixels: its own background where it has
 * one, so the logo reads as a whole cover; a light one for a logo floating
 * on transparency that a dark one would partly swallow; otherwise null. */
export function sleeveFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Rgb | null {
  let border = 0
  let solidBorder = 0
  let dark = 0
  let solid = 0
  let light = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const isSolid = data[i + 3]! >= OPAQUE_ALPHA
      if (y === 0 || y === height - 1 || x === 0 || x === width - 1) {
        border++
        if (isSolid) solidBorder++
      }
      if (isSolid) {
        solid++
        const pixel = (data[i]! + data[i + 1]! + data[i + 2]!) / 3
        if (pixel < DARK_PIXEL) dark++
        if (pixel >= LIGHT_PIXEL) light++
      }
    }
  }
  if (solidBorder / border >= SOLID_BORDER_SHARE) return backgroundFromPixels(data, width, height)
  const partlySwallowed = dark / solid >= MIN_DARK_SHARE && light / solid <= MAX_LIGHT_SHARE
  return partlySwallowed ? LIGHT_SLEEVE : null
}

/** How much of the image's longer side the logo takes up, so one drawn with
 * a wide transparent margin can be sized by the logo and not the margin. */
export function logoFill(data: Uint8ClampedArray, width: number, height: number): number {
  let left = width
  let right = -1
  let top = height
  let bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! < OPAQUE_ALPHA) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < 0) return 1
  const extent = Math.max((right - left + 1) / width, (bottom - top + 1) / height)
  return Math.max(extent, MIN_FILL)
}

/** Reads a logo already fetched and held as an object URL, so nothing goes
 * over the network for it. Null if it cannot be read. */
export function readLogoLook(url: string): Promise<LogoLook | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = SAMPLE_SIZE
        canvas.height = SAMPLE_SIZE
        const context = canvas.getContext('2d')
        if (!context) {
          resolve(null)
          return
        }
        context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
        const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
        resolve({
          sleeve: sleeveFromPixels(data, SAMPLE_SIZE, SAMPLE_SIZE),
          pixels: Math.max(image.naturalWidth, image.naturalHeight),
          fill: logoFill(data, SAMPLE_SIZE, SAMPLE_SIZE),
        })
      } catch {
        resolve(null)
      }
    }
    image.onerror = () => resolve(null)
    image.src = url
  })
}
