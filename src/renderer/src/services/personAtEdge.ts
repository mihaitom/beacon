/**
 * Whether a person reaches a photo's left edge - an arm, a face, a band
 * standing at the side. The one thing services/edgeFill.ts's checks can't
 * tell from a calm edge: a bare arm against a plain background is as even
 * as the background, and continuing it streaks it across the page.
 *
 * MediaPipe's selfie segmenter, shipped with the app (the wasm and the
 * 250 KB model) rather than fetched from a CDN, so it works offline. It is
 * loaded on first use only, and a failure to load just leaves the
 * decision to the other checks.
 */
import type { ImageSegmenter } from '@mediapipe/tasks-vision'
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'
import modelAssetPath from '@/assets/models/selfie_segmenter.tflite?url'
import { type Frame, visibleRect } from './edgeFill'

/** The strip judged: ~9% of the width, as edgeFill.ts's smoothness check. */
const STRIP = 0.09
/** Share of the strip that may be person. Measured on the cached Fanart.tv
 * backgrounds: edges that continue well came to at most 0.08, every arm,
 * face or group reaching the edge to 0.16 and up. */
const MAX_PERSON = 0.12

let segmenter: Promise<ImageSegmenter | null> | null = null

/** The segmenter, loaded once; null where it can't be (no WebAssembly, a
 * test environment). */
export function loadSegmenter(): Promise<ImageSegmenter | null> {
  segmenter ??= import('@mediapipe/tasks-vision')
    .then(({ ImageSegmenter }) =>
      ImageSegmenter.createFromOptions(
        { wasmLoaderPath, wasmBinaryPath },
        {
          baseOptions: { modelAssetPath, delegate: 'CPU' },
          runningMode: 'IMAGE',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        },
      ),
    )
    .catch((error: unknown) => {
      console.warn('[person-at-edge] Segmenter unavailable:', error)
      return null
    })
  return segmenter
}

/** How much of the left strip of `rect` a person covers, from a `width` x
 * `height` confidence mask of the whole picture. */
export function personShare(
  mask: Float32Array,
  width: number,
  height: number,
  rect: { x: number; y: number; width: number; height: number },
): number {
  const left = Math.floor(rect.x)
  const right = Math.max(left + 1, Math.floor(rect.x + rect.width * STRIP))
  const top = Math.floor(rect.y)
  const bottom = Math.min(height, Math.ceil(rect.y + rect.height))
  let person = 0
  let count = 0
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < Math.min(width, right); x++) {
      if (mask[y * width + x]! > 0.5) person++
      count++
    }
  }
  return count ? person / count : 0
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/** Whether a person reaches the left edge of the photo at `url` as `frame`
 * shows it, judged over its top `extent` (see edgeFill.ts's
 * extractLeftEdge). False where it can't be told. */
export async function personAtLeftEdge(url: string, frame: Frame, extent = 1): Promise<boolean> {
  const [model, img] = await Promise.all([loadSegmenter(), loadImage(url)])
  if (!model || !img) return false
  try {
    const result = model.segment(img)
    try {
      const mask = result.confidenceMasks?.[0]
      if (!mask) return false
      // The mask has the picture's proportions, so its shown part is the
      // same rectangle edgeFill.ts reads the colours from.
      const shown = visibleRect(mask.width, mask.height, frame)
      const judged = { ...shown, height: shown.height * extent }
      return personShare(mask.getAsFloat32Array(), mask.width, mask.height, judged) > MAX_PERSON
    } finally {
      result.close()
    }
  } catch (error) {
    console.warn('[person-at-edge] Segmenting failed:', error)
    return false
  }
}
