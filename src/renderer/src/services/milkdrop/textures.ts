import type { MilkdropPreset, MilkdropVisualizer } from 'butterchurn'

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

/** Numbers rather than a picture, at full float precision and read texel
 * by texel (`texelFetch`): no filtering, no mipmaps, nothing rounded to
 * 8 bits as a picture would be. */
export function setDataTexture(
  visualizer: MilkdropVisualizer,
  name: string,
  data: Float32Array,
  width: number,
  height: number,
): boolean {
  const renderer = (visualizer as unknown as RendererInternals).renderer
  const gl = renderer?.gl
  const image = renderer?.image
  if (!gl || !image?.samplers) return false
  image.samplers[name] ??= gl.createTexture() ?? undefined
  const texture = image.samplers[name]
  if (!texture) return false
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return true
}

/** Where the song's cover comes from - the app's cover cache, or the party
 * guest page's own route. `key` tells one cover from the next; `load`
 * fetches it at about COVER_SIZE, or null where the song has none. */
export interface MilkdropCover {
  key: string
  load(signal: AbortSignal): Promise<Blob | null>
}

/** A cover's bytes, square, ready for the GPU: a bitmap made from them
 * rather than an <img> pointing at connect, which would be cross-origin in
 * the desktop app, and WebGL refuses to read a picture from another
 * origin. A cover that is not square is cut to its middle, as the app
 * shows covers everywhere else, rather than squeezed. */
export async function coverPicture(blob: Blob): Promise<ImageBitmap> {
  const full = await createImageBitmap(blob)
  try {
    const side = Math.min(full.width, full.height)
    const left = Math.floor((full.width - side) / 2)
    const top = Math.floor((full.height - side) / 2)
    return await createImageBitmap(full, left, top, side, side, {
      resizeWidth: COVER_SIZE,
      resizeHeight: COVER_SIZE,
      resizeQuality: 'high',
    })
  } finally {
    full.close()
  }
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

// Pictures Beacon ships for its own presets (assets/milkdrop/pictures/),
// each read as `sampler_<file name>`. As URLs: only a preset that asks for
// one downloads it.
const SHIPPED_PICTURES = import.meta.glob<string>('@/assets/milkdrop/pictures/*.jpg', {
  query: '?url',
  import: 'default',
})

function pictureName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.'))
}

/** The shipped pictures the preset's shaders read, by name. */
export function shippedPicturesFor(preset: MilkdropPreset): string[] {
  const shaders = `${String(preset.warp ?? '')}${String(preset.comp ?? '')}`
  return Object.keys(SHIPPED_PICTURES)
    .map(pictureName)
    .filter((name) => new RegExp(`\\bsampler_${name}\\b`).test(shaders))
}

// Each decoded once per session: they never change.
const shippedCache = new Map<string, Promise<ImageBitmap>>()

/** A shipped picture, ready for the GPU. */
export function loadShippedPicture(name: string): Promise<ImageBitmap> {
  let pending = shippedCache.get(name)
  if (!pending) {
    const entry = Object.entries(SHIPPED_PICTURES).find(([path]) => pictureName(path) === name)
    if (!entry) return Promise.reject(new Error(`No shipped picture: ${name}`))
    pending = entry[1]()
      .then((url) => fetch(url))
      .then((response) => response.blob())
      .then((blob) => createImageBitmap(blob))
    shippedCache.set(name, pending)
    pending.catch(() => shippedCache.delete(name))
  }
  return pending
}

/** Whether the preset draws Milkdrop's own waveform: not when its alpha is
 * zero and no equation turns it up. */
function drawsWaveform(preset: MilkdropPreset): boolean {
  const alpha = Number((preset.baseVals as Record<string, unknown> | undefined)?.wave_a ?? 1)
  return alpha > 0 || /\bwave_a\s*=/.test(String(preset.frame_eqs_str ?? ''))
}

/** The preset with its waveform drawn in the accent, if it is one of those
 * that take the accent at all. The waveform's colour is a plain value the
 * shaders never see, so it is set here, on loading. One that draws no
 * waveform is handed back as it is: the accent reaches its shaders as a
 * texture, and loading it again for a new accent would restart it. */
export function withAccent(preset: MilkdropPreset, triplet: string): MilkdropPreset {
  const shaders = `${String(preset.warp ?? '')}${String(preset.comp ?? '')}`
  if (!shaders.includes(`sampler_${ACCENT_SAMPLER}`)) return preset
  if (!drawsWaveform(preset)) return preset
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
