/** How much of the image, from its bottom edge up, sits behind the text and
 * controls of a bottom-anchored layout. */
const BOTTOM_SHARE = 0.45

/** How much of the scrim's darkest point the controls actually sit on: they
 * are near, not at, the bottom edge it fades up from. */
const SCRIM_AT_CONTROLS = 0.8

export type Rgb = [number, number, number]

/**
 * The average colour of an image's bottom band, the part a bottom scrim lies
 * over. Null where the image cannot be loaded or read (a CORS-tainted
 * canvas) - callers fall back to a default.
 */
export async function measureBottomColor(url: string): Promise<Rgb | null> {
  const SAMPLE_SIZE = 32

  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = SAMPLE_SIZE
        canvas.height = SAMPLE_SIZE
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(null)
          return
        }
        ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
        const top = Math.floor(SAMPLE_SIZE * (1 - BOTTOM_SHARE))
        const { data } = ctx.getImageData(0, top, SAMPLE_SIZE, SAMPLE_SIZE - top)
        const sum: Rgb = [0, 0, 0]
        for (let i = 0; i < data.length; i += 4) {
          sum[0] += data[i]!
          sum[1] += data[i + 1]!
          sum[2] += data[i + 2]!
        }
        const count = data.length / 4
        resolve(count ? (sum.map((channel) => Math.round(channel / count)) as Rgb) : null)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/** Perceived lightness, 0 dark - 1 white: Rec. 709 weights on the encoded
 * values, which is what decides whether white text stands out. */
export function lightnessOf([r, g, b]: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/** Darkest point of the bottom scrim over a photo whose bottom band has the
 * given colour: enough for white text over a dark photo, a good deal more
 * over a light one, where the same scrim left the labels washed out. */
export function bottomScrimStrength(bottom: Rgb | null): number {
  if (bottom == null) return 0.65
  return Math.min(0.9, Math.max(0.5, 0.45 + 0.5 * lightnessOf(bottom)))
}

/** What the controls actually sit on: the photo's bottom colour under the
 * scrim's black at the controls' height. */
export function colourBehindControls(bottom: Rgb, strength: number): Rgb {
  const keep = 1 - strength * SCRIM_AT_CONTROLS
  return bottom.map((channel) => Math.round(channel * keep)) as Rgb
}
