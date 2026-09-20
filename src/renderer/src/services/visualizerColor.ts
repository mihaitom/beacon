/**
 * Picking a colour the Now Playing visualizer bars can actually be seen in.
 *
 * The bars take their colour from the artist background (see
 * NowPlayingView.vue's visualizerColor). That works while the background has
 * a real colour, but a black-and-white or very dark photo extracts to a grey
 * or near-black, and bars drawn in it vanish into the picture behind them -
 * the exact case this exists for. So a grey or dark extraction falls back to
 * the app's amber, and anything kept is lifted to a brightness and
 * saturation that stands off the background rather than matching it.
 */

/** The app's amber - what the bars use with no background at all. */
export const VISUALIZER_FALLBACK = '245, 169, 78'

/** Below these the extracted colour has nothing to pop with: `s` is how
 * close to grey it is (hue barely matters then), `l` how dark. */
const MIN_SATURATION = 0.2
const MIN_LIGHTNESS = 0.25
/** What a kept colour is lifted to. Not full white: the bars should still
 * read as a colour, not as a grey overlay. */
const TARGET_SATURATION = 0.65
const TARGET_LIGHTNESS_MIN = 0.55
const TARGET_LIGHTNESS_MAX = 0.72

/** An "r, g, b" string (what colorExtractor.ts returns) as bars can use it,
 * or VISUALIZER_FALLBACK when it is grey, dark, or unparseable. */
export function visualizerBarColor(rgb: string | null): string {
  if (!rgb) return VISUALIZER_FALLBACK
  const parts = rgb.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) {
    return VISUALIZER_FALLBACK
  }
  const [h, s, l] = rgbToHsl(parts[0]!, parts[1]!, parts[2]!)
  if (s < MIN_SATURATION || l < MIN_LIGHTNESS) return VISUALIZER_FALLBACK
  return hslToRgbString(
    h,
    Math.max(s, TARGET_SATURATION),
    Math.min(Math.max(l, TARGET_LIGHTNESS_MIN), TARGET_LIGHTNESS_MAX),
  )
}

/** All three in 0..1. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === red) h = ((green - blue) / d + (green < blue ? 6 : 0)) / 6
  else if (max === green) h = ((blue - red) / d + 2) / 6
  else h = ((red - green) / d + 4) / 6
  return [h, s, l]
}

function hslToRgbString(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number): number => {
    let value = t
    if (value < 0) value += 1
    if (value > 1) value -= 1
    if (value < 1 / 6) return p + (q - p) * 6 * value
    if (value < 1 / 2) return q
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6
    return p
  }
  return [h + 1 / 3, h, h - 1 / 3].map((t) => Math.round(channel(t) * 255)).join(', ')
}
