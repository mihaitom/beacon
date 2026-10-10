/**
 * The artwork edge length every mobile list row uses — Queue, Songs,
 * Albums, Playlists and Radio.
 *
 * A constant rather than a CSS custom property because CoverArt takes its
 * size as a prop (it decides which resolution to request, not just how big
 * to draw it), so this number has to exist in JS. Its CSS counterpart is
 * `.mobile-row__art` in assets/base.css, which reserves the matching space
 * — the two are meant to move together.
 */
export const MOBILE_ROW_ART_SIZE = 48

/**
 * The height every mobile list row renders at — `.mobile-row`'s min-height
 * in assets/base.css, which the rows' own padding and borders stay under.
 * The mobile lists are virtualized and lay themselves out from this
 * number, so it has to move together with that rule.
 */
export const MOBILE_ROW_HEIGHT = 60
