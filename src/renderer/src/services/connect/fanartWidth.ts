/** The widths connect scales a Fanart.tv image down to - its
 * core/fanart.py's IMAGE_WIDTHS; any other width gets the full image. */
const IMAGE_WIDTHS = [1280, 1920, 2560]
const LARGEST = 2560

/** Below this short side (CSS px) the screen is a phone's. */
const PHONE_SHORT_SIDE = 600

/** The width to ask connect for, or null for the full image: the screen's
 * long side in device pixels, since a backdrop may fill it either way
 * round, rounded up to the next step. A phone never asks for more than the
 * largest step - it shows the photo cropped and darkened behind Now
 * Playing, where 4K costs megabytes on mobile data and shows no
 * difference. Store-free, so the party guest page can use it too. */
export function fanartImageWidth(): number | null {
  const { width, height } = window.screen
  const longSide = Math.max(width, height) * (window.devicePixelRatio || 1)
  const step = IMAGE_WIDTHS.find((w) => w >= longSide)
  if (step) return step
  return Math.min(width, height) < PHONE_SHORT_SIDE ? LARGEST : null
}
