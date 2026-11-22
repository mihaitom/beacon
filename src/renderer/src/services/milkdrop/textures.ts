import type { MilkdropPreset, MilkdropVisualizer } from 'butterchurn'
import { fetchCoverArtBatched } from '@/services/connect/coverArtBatch'

/** The pictures Beacon hands its own presets, each read in their shaders as
 * `uniform sampler2D sampler_<name>;`: the song's cover, and the theme's
 * accent as a single pixel - Butterchurn has no way to pass a preset a
 * value of its own, but a texture it does. */
export const COVER_SAMPLER = 'cover'
export const ACCENT_SAMPLER = 'accent'
// Square, and a size the cover cache already holds for Now Playing.
export const COVER_SIZE = 512

/** The parts of Butterchurn's renderer this reaches into. Its public
 * loadExtraImages() loads a name once and never again, and takes only a
 * URL - one song's cover would stay for good. Pinned to 2.6.7 in
 * package.json; a version that moves these fails the check below and
 * leaves Butterchurn's own stand-in texture rather than breaking (and
 * textures.browser.test.ts fails). */
interface RendererInternals {
  renderer?: {
    gl?: WebGL2RenderingContext
    image?: {
      samplers: Record<string, WebGLTexture | undefined>
      bindTexture(texture: WebGLTexture, data: TexImageSource, width: number, height: number): void
    }
  }
}

/** Puts `picture` where the presets' `sampler_<name>` reads, replacing what
 * was there. False when this Butterchurn has no room for it. */
export function setTexture(
  visualizer: MilkdropVisualizer,
  name: string,
  picture: TexImageSource,
): boolean {
  const renderer = (visualizer as unknown as RendererInternals).renderer
  const gl = renderer?.gl
  const image = renderer?.image
  if (!gl || !image?.samplers || typeof image.bindTexture !== 'function') return false
  image.samplers[name] ??= gl.createTexture() ?? undefined
  const texture = image.samplers[name]
  if (!texture) return false
  const { width, height } = picture as { width: number; height: number }
  image.bindTexture(texture, picture, width, height)
  return true
}

/** A song's cover, square, ready for the GPU. Through the app's cover cache,
 * and as a bitmap made from the bytes rather than an <img> pointing at
 * connect: that one would be cross-origin in the desktop app, and WebGL
 * refuses to read a picture from another origin. */
export async function loadCoverPicture(
  coverArtId: string,
  signal: AbortSignal,
): Promise<ImageBitmap> {
  const blob = await fetchCoverArtBatched(coverArtId, COVER_SIZE, signal)
  return createImageBitmap(blob, {
    resizeWidth: COVER_SIZE,
    resizeHeight: COVER_SIZE,
    resizeQuality: 'high',
  })
}

function onePixel(colour: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')
  if (context) {
    context.fillStyle = colour
    context.fillRect(0, 0, 1, 1)
  }
  return canvas
}

/** What stands in without a cover (a radio station, a song without art): a
 * dark grey, so a preset built around the cover shows its motion on
 * something calm instead of Butterchurn's own cloud picture. */
export function placeholderPicture(): HTMLCanvasElement {
  return onePixel('#1c1b1f')
}

/** The accent, an "r, g, b" triplet as services/appAccent.ts keeps it. */
export function accentPicture(triplet: string): HTMLCanvasElement {
  return onePixel(`rgb(${triplet})`)
}

/** The preset with its waveform drawn in the accent, if it is one of those
 * that take the accent at all. The waveform's colour is a plain value the
 * shaders never see, so it is set here, on loading. */
export function withAccent(preset: MilkdropPreset, triplet: string): MilkdropPreset {
  const shaders = `${String(preset.warp ?? '')}${String(preset.comp ?? '')}`
  if (!shaders.includes(`sampler_${ACCENT_SAMPLER}`)) return preset
  const [r, g, b] = triplet.split(',').map((part) => Number(part.trim()) / 255)
  if (![r, g, b].every((value) => Number.isFinite(value))) return preset
  const baseVals = {
    ...(preset.baseVals as Record<string, unknown>),
    wave_r: r,
    wave_g: g,
    wave_b: b,
  }
  return { ...preset, baseVals }
}
