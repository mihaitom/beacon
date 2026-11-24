// The blend is drawn on a 2D canvas, which jsdom does not have.
import { describe, expect, it, vi } from 'vitest'
import { PictureFade } from '../pictureFade'

function solid(colour: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 4
  const context = canvas.getContext('2d')!
  context.fillStyle = colour
  context.fillRect(0, 0, 4, 4)
  return canvas
}

function red(picture: CanvasImageSource): number {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 4
  const context = canvas.getContext('2d')!
  context.drawImage(picture, 0, 0, 4, 4)
  return context.getImageData(1, 1, 1, 1).data[0]!
}

describe('PictureFade', () => {
  it('puts the first picture straight up', () => {
    const fade = new PictureFade(4, 1000)
    const first = solid('rgb(255, 0, 0)')
    expect(fade.show(first, 0)).toBe(first)
    expect(fade.step(10)).toBeNull()
  })

  it('fades from the last picture to the next, ending on the picture itself', () => {
    const fade = new PictureFade(4, 1000)
    fade.show(solid('rgb(255, 0, 0)'), 0)
    const next = solid('rgb(0, 0, 0)')
    expect(red(fade.show(next, 0))).toBeGreaterThan(250)
    const halfway = red(fade.step(500)!)
    expect(halfway).toBeGreaterThan(100)
    expect(halfway).toBeLessThan(155)
    expect(fade.step(1000)).toBe(next)
    expect(fade.step(1100)).toBeNull()
  })

  it('starts a fade from where the one under way had got to', () => {
    const fade = new PictureFade(4, 1000)
    fade.show(solid('rgb(255, 0, 0)'), 0)
    fade.show(solid('rgb(0, 0, 0)'), 0)
    fade.step(500)
    const start = red(fade.show(solid('rgb(0, 0, 0)'), 500))
    expect(start).toBeGreaterThan(100)
    expect(start).toBeLessThan(155)
  })

  it('closes a bitmap once the next picture has replaced it', async () => {
    const fade = new PictureFade(4, 1000)
    const bitmap = await createImageBitmap(solid('rgb(255, 0, 0)'))
    const close = vi.spyOn(bitmap, 'close')
    fade.show(bitmap, 0)
    expect(close).not.toHaveBeenCalled()
    fade.show(solid('rgb(0, 0, 0)'), 0)
    expect(close).toHaveBeenCalled()
  })
})
