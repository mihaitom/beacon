/** Whether a scrolling shelf is already at one end of its row, so the
 * chevron pointing that way can say so.
 *
 * Shared by AlbumShelf.vue and CardShelf.vue, which both draw that pair of
 * buttons — the same reason cardRowFit.ts next to it is shared.
 */

export interface ShelfEdges {
  atStart: boolean
  atEnd: boolean
}

/** What a shelf reports before it has ever been measured: rows start at
 * their left edge, and whether there is anything to the right is not known
 * until the browser has laid one out. */
export const SHELF_EDGES_UNMEASURED: ShelfEdges = { atStart: true, atEnd: false }

/** A row shorter than its own box does not scroll at all, so both ends are
 * "reached" and neither chevron has anywhere to go. The 1px slack absorbs
 * the fractional scrollLeft a browser hands back after a smooth scroll —
 * without it the right chevron stays enabled a pixel short of the end. */
function measure(el: HTMLElement): ShelfEdges {
  return {
    atStart: el.scrollLeft <= 1,
    atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
  }
}

/** Reports where `el` sits now and whenever that changes — on scroll, when
 * the row is resized, and whenever the caller asks (see the returned
 * `refresh`, for a shelf whose cards have changed underneath it).
 *
 * A row with no width or no scrollWidth is not a shelf at one end, it is a
 * shelf nothing has laid out yet (a hidden tab, jsdom under test); it
 * reports nothing at all rather than a measurement of zero, so the caller's
 * own SHELF_EDGES_UNMEASURED default stands until a real one arrives. Same
 * reasoning as cardRowFit.ts's own zero-width guard.
 */
export function observeShelfEdges(
  el: HTMLElement,
  onChange: (edges: ShelfEdges) => void,
): { refresh: () => void; stop: () => void } {
  // Only on a real change. A scroll fires this per frame, and the caller
  // re-checks after every render (its cards can change underneath it) — an
  // unconditional callback there sets a fresh object every time, which
  // re-renders, which re-checks: Vue stops that with "Maximum recursive
  // updates exceeded", and it took exactly that to notice.
  let last: ShelfEdges | null = null
  const report = () => {
    if (el.clientWidth === 0 || el.scrollWidth === 0) return
    const next = measure(el)
    if (last && last.atStart === next.atStart && last.atEnd === next.atEnd) return
    last = next
    onChange(next)
  }
  report()

  el.addEventListener('scroll', report, { passive: true })
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report)
  observer?.observe(el)

  return {
    refresh: report,
    stop() {
      el.removeEventListener('scroll', report)
      observer?.disconnect()
    },
  }
}
