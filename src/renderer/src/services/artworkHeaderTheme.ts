import type { EdgeFills } from './edgeFill'
import { isDarkColor } from './themeColors'

export interface HeaderThemes {
  /** The page's own theme. */
  theme: string
  /** Its dark counterpart (plugins/theme.ts's nightTheme()). */
  nightTheme: string
  /** Its light counterpart (plugins/theme.ts's dayTheme()). */
  dayTheme: string
}

/** "rgb(r, g, b)", as services/edgeFill.ts writes its colours, as "#rrggbb". */
function rgbToHex(rgb: string): string | null {
  const parts = rgb.match(/\d+/g)
  if (!parts || parts.length < 3) return null
  return `#${parts
    .slice(0, 3)
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('')}`
}

/**
 * The theme a hero card (DetailHeader.vue, HeroBand.vue) is drawn in over
 * Fanart.tv art: dark text on a pale card where the art's left edge - what
 * is continued under the text - is light, white text on a dark one where it
 * is dark, whatever the page's own theme. Over the blurred cover, or while
 * the art's edge is still being read, the page's own theme.
 */
export function artworkHeaderTheme(
  hasArt: boolean,
  fills: EdgeFills | null,
  themes: HeaderThemes,
): string {
  if (!hasArt || !fills) return themes.theme
  const edge = rgbToHex(fills.left.flat)
  if (!edge) return themes.theme
  return isDarkColor(edge) ? themes.nightTheme : themes.dayTheme
}
