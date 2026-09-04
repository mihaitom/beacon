/** How many cards fit across a shelf, for the components that lay one out.
 *
 * Shared because the answer has to be the same in all of them: a shelf's
 * placeholders are supposed to look like the row that is about to replace
 * them, and a hardcoded count only looks right at one window size. Home's
 * two Discover shelves are where that showed - they are the slowest to load
 * (a real lookup, not the library cache), so they are the ones anyone
 * actually sees in their loading state, and on a wide window six or eight
 * placeholders left the row visibly half-empty until the content arrived.
 *
 * The numbers are the real ones: every card in these rows is 160px wide,
 * and both AlbumShelf.vue's own row and CardShelf.vue's use a 20px gap. */

export const CARD_WIDTH = 160
export const CARD_GAP = 20

/** Cards that fit across `width` pixels, at least one. */
export function cardsAcross(width: number): number {
  return Math.max(1, Math.floor((width + CARD_GAP) / (CARD_WIDTH + CARD_GAP)))
}

/** How many placeholders to draw for a row that wide.
 *
 * One more than fits, deliberately: these rows scroll, so a row of
 * placeholders that stops exactly at the edge reads as a complete shelf,
 * while the real content it stands in for carries on past it. The extra one
 * is clipped by the row's own overflow and costs nothing. */
export function skeletonsAcross(width: number): number {
  return cardsAcross(width) + 1
}

/** Watches `el` and reports how many cards fit whenever that changes,
 * starting with what fits right now — measured synchronously, so the first
 * paint already has the right number instead of growing into it a frame
 * later.
 *
 * A width of zero is never reported: that is not a narrow shelf, it is one
 * that hasn't been laid out (a hidden tab, jsdom under test), and answering
 * it with "one card fits" would collapse the row to a single placeholder.
 * The caller's own default stands until a real measurement arrives.
 *
 * Returns the observer to disconnect on unmount, or null where there is
 * nothing to observe with (jsdom under test, a very old browser): the
 * initial measurement still happens, and a row that never re-measures is a
 * far better failure than one that throws on mount. */
export function observeCardsAcross(
  el: Element,
  onChange: (width: number) => void,
): ResizeObserver | null {
  const report = (width: number) => {
    if (width > 0) onChange(width)
  }
  report(el.clientWidth)
  if (typeof ResizeObserver === 'undefined') return null
  const observer = new ResizeObserver((entries) => report(entries[0]?.contentRect.width ?? 0))
  observer.observe(el)
  return observer
}
