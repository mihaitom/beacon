/** How much of the image, from its bottom edge up, sits behind the text and
 * controls of a bottom-anchored layout. */
const BOTTOM_SHARE = 0.45

/**
 * The average lightness (0 dark - 1 white) of an image's bottom band, the
 * part a bottom scrim lies over. Null where the image cannot be loaded or
 * read (a CORS-tainted canvas) - callers fall back to a default.
 */
export async function measureBottomBrightness(url: string): Promise<number | null> {
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
        let sum = 0
        let count = 0
        for (let i = 0; i < data.length; i += 4) {
          // Rec. 709 weights on the encoded values: perceived lightness,
          // which is what decides whether white text stands out.
          sum += (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255
          count += 1
        }
        resolve(count ? sum / count : null)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/** Darkest point of the bottom scrim for a photo of the given brightness:
 * enough for white text over a dark photo, a good deal more over a light
 * one, where the same scrim left the labels washed out. */
export function bottomScrimStrength(brightness: number | null): number {
  if (brightness == null) return 0.65
  return Math.min(0.9, Math.max(0.5, 0.45 + 0.5 * brightness))
}
