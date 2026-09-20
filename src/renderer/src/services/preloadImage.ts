/**
 * Resolves once `url` can be painted, or straight away on error - the caller
 * is about to put it on screen, and a missing image must not leave it
 * waiting.
 *
 * Used before swapping a backdrop layer: setting a layer's background-image
 * and activating it in the same tick shows nothing until the bytes land,
 * then the image appears at whatever opacity the crossfade has already
 * reached - or at full, if the fade finished first, which is a pop rather
 * than a fade. Waiting for the load first means the transition has an image
 * to fade *to*.
 */
export function preloadImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve()
    img.onerror = () => resolve()
    img.src = url
  })
}
