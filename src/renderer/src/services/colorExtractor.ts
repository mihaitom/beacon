/**
 * Extracts a representative color from an image URL by sampling a
 * downscaled canvas and weighting pixels toward saturation and mid
 * lightness — a plain average tends toward a muddy gray for most album
 * covers (a lot of pixels are near-white/near-black backgrounds and
 * borders), so this biases the result toward whatever's actually
 * colorful in the artwork instead.
 *
 * Returns null if the image can't be loaded, the canvas read fails (e.g.
 * a CORS-tainted canvas), or the artwork turns out fully grayscale —
 * callers should fall back to a default color in all of those cases.
 */
export async function extractDominantColor(
  url: string,
): Promise<[number, number, number] | null> {
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
        const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)

        let rSum = 0
        let gSum = 0
        let bSum = 0
        let weightSum = 0

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]!
          const g = data[i + 1]!
          const b = data[i + 2]!
          const alpha = data[i + 3]!
          if (alpha < 128) continue

          const max = Math.max(r, g, b)
          const min = Math.min(r, g, b)
          const lightness = (max + min) / 2 / 255
          const saturation = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255))
          // De-emphasizes near-white/near-black pixels that would
          // otherwise wash the result out toward gray.
          const weight = saturation ** 2 * (1 - Math.abs(lightness - 0.5) * 1.4)
          if (weight <= 0) continue

          rSum += r * weight
          gSum += g * weight
          bSum += b * weight
          weightSum += weight
        }

        if (weightSum === 0) {
          resolve(null)
          return
        }
        resolve([
          Math.round(rSum / weightSum),
          Math.round(gSum / weightSum),
          Math.round(bSum / weightSum),
        ])
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}
