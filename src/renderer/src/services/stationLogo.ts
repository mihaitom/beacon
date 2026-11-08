import { backgroundFromPixels } from '@/services/edgeFill'

type Rgb = [number, number, number]

/** What a station's logo needs from the sleeve it stands on. */
export interface LogoLook {
  /** The sleeve's colour; null for the neutral one. */
  sleeve: Rgb | null
  /** The logo's longer side in pixels; 0 if it has none of its own (SVG). */
  pixels: number
}

const SAMPLE_SIZE = 32
const OPAQUE_ALPHA = 128
// Below this share of opaque border pixels the logo floats on transparency
// and has no background of its own to continue.
const SOLID_BORDER_SHARE = 0.9
// Mean brightness (0-255) under which a floating logo would vanish into the
// dark neutral sleeve: a black wordmark, typically.
const DARK_LOGO = 64
const LIGHT_SLEEVE: Rgb = [232, 232, 236]

/** The sleeve colour for a logo's pixels: its own background where it has
 * one, so the logo reads as a whole cover; a light one for a dark logo
 * floating on transparency; otherwise null. */
export function sleeveFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Rgb | null {
  let border = 0
  let solidBorder = 0
  let brightness = 0
  let solid = 0
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
        brightness += (data[i]! + data[i + 1]! + data[i + 2]!) / 3
      }
    }
  }
  if (solidBorder / border >= SOLID_BORDER_SHARE) return backgroundFromPixels(data, width, height)
  return solid && brightness / solid < DARK_LOGO ? LIGHT_SLEEVE : null
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
        })
      } catch {
        resolve(null)
      }
    }
    image.onerror = () => resolve(null)
    image.src = url
  })
}
