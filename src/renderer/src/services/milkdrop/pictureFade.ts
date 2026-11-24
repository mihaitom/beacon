/** A picture handed to a preset (the cover, the accent) faded over from the
 * one before rather than cut to: a new song otherwise changes every colour
 * taken from them in a single frame. `show` gives what to put up now and
 * `step` what to put up each frame after, until the fade is done; the last
 * step hands back the picture itself, not a copy of it.
 *
 * It keeps the picture shown until the next one replaces it, as the fade
 * starts from it, and closes it then if it is a bitmap. */
export type FadePicture = ImageBitmap | HTMLCanvasElement

export class PictureFade {
  private current: FadePicture | null = null
  private readonly from: HTMLCanvasElement
  private readonly blend: HTMLCanvasElement
  private startedAt = 0
  private fading = false

  constructor(
    private readonly size: number,
    private readonly ms: number,
  ) {
    this.from = canvas(size)
    this.blend = canvas(size)
  }

  show(picture: FadePicture, now: number): FadePicture {
    const previous = this.current
    this.current = picture
    const context = this.from.getContext('2d')
    // The first picture, or nowhere to blend (no 2D canvas): straight up.
    if (!previous || !context) {
      this.fading = false
      release(previous)
      return picture
    }
    context.clearRect(0, 0, this.size, this.size)
    context.drawImage(this.fading ? this.blend : previous, 0, 0, this.size, this.size)
    release(previous)
    this.fading = true
    this.startedAt = now
    return this.from
  }

  /** What to show this frame, or null when nothing changes. */
  step(now: number): FadePicture | null {
    if (!this.fading || !this.current) return null
    const t = (now - this.startedAt) / this.ms
    if (t >= 1) {
      this.fading = false
      return this.current
    }
    const context = this.blend.getContext('2d')
    if (!context) return null
    context.globalAlpha = 1
    context.drawImage(this.from, 0, 0)
    // Eased, so it neither starts nor lands with a jolt.
    context.globalAlpha = Math.max(t, 0) * Math.max(t, 0) * (3 - 2 * Math.max(t, 0))
    context.drawImage(this.current, 0, 0, this.size, this.size)
    return this.blend
  }

  dispose(): void {
    release(this.current)
    this.current = null
    this.fading = false
  }
}

function canvas(size: number): HTMLCanvasElement {
  const element = document.createElement('canvas')
  element.width = element.height = size
  return element
}

function release(picture: FadePicture | null): void {
  if (picture && 'close' in picture) picture.close()
}
