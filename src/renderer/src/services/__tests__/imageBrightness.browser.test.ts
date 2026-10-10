// Real-browser test - run via `pnpm test:layout`. Reading pixels back
// needs a real canvas, which jsdom does not have.
import { describe, expect, it } from 'vitest'
import { bottomScrimStrength, measureBottomBrightness } from '../imageBrightness'

/** A 100x100 picture, `top` above the middle and `bottom` below it. */
function picture(top: string, bottom: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = 100
  canvas.height = 100
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = top
  ctx.fillRect(0, 0, 100, 50)
  ctx.fillStyle = bottom
  ctx.fillRect(0, 50, 100, 50)
  return canvas.toDataURL('image/png')
}

describe('the bottom brightness of a photo', () => {
  it('reads the band the text lies over, not the whole picture', async () => {
    // A white sky over a dark floor is a dark place for the text, and the
    // other way round a light one.
    expect(await measureBottomBrightness(picture('#fff', '#000'))).toBeLessThan(0.15)
    expect(await measureBottomBrightness(picture('#000', '#fff'))).toBeGreaterThan(0.85)
  })

  it('darkens a light photo more than a dark one', async () => {
    const light = await measureBottomBrightness(picture('#000', '#eee'))
    const dark = await measureBottomBrightness(picture('#eee', '#222'))

    expect(bottomScrimStrength(light)).toBeGreaterThan(bottomScrimStrength(dark))
  })

  it('gives up on an image it cannot load', async () => {
    expect(await measureBottomBrightness('data:image/png;base64,broken')).toBeNull()
    // ...and the scrim still darkens, at a middling strength.
    expect(bottomScrimStrength(null)).toBeGreaterThan(0.5)
  })
})
