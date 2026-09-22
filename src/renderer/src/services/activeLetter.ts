/** AlphabetIndexBar's "you are here" highlight: which letter's section the
 * reader is currently looking at.
 *
 * The reference line is the middle of the viewport, not its top — the plain
 * grids' jumpToLetter() scrollIntoView({ block: 'center' }) lands the picked
 * letter's first item there, so the highlight agrees with the jump the
 * moment it settles. What sits at that point is read straight off the
 * rendered item (elementsFromPoint), which is what makes this work under
 * v-virtual-scroll too: only the rows near the viewport exist, and one of
 * those is exactly what the point is over.
 *
 * jsdom implements neither elementsFromPoint nor real scrolling, so there
 * the whole thing is a no-op (the highlight just stays unset) instead of a
 * stub every view test would have to add.
 */

export interface ActiveLetterHandle {
  /** Recomputes now, without waiting for the next scroll frame — for a
   * filter change, which moves the letters without scrolling anything. */
  update(): void
  stop(): void
}

export interface ActiveLetterOptions {
  /** CSS selector matching one rendered item (a card, a song row). */
  itemSelector: string
  /** That item's index in the full (filtered) list, read from the attribute
   * its own view puts on it. */
  readIndex: (item: Element) => number | null
  /** The bar's letter → first-index map, read fresh each update: it moves
   * with the filter. */
  letterFirstIndex: () => Map<string, number>
  onChange: (letter: string | null) => void
}

export function observeActiveLetter(options: ActiveLetterOptions): ActiveLetterHandle {
  const { itemSelector, readIndex, letterFirstIndex, onChange } = options
  let frame = 0

  const update = () => {
    frame = 0
    if (typeof document.elementsFromPoint !== 'function') return
    const x = Math.round(window.innerWidth / 2)
    const y = Math.round(window.innerHeight / 2)
    const item = document
      .elementsFromPoint(x, y)
      .map((element) => element.closest(itemSelector))
      .find((element): element is Element => element !== null)
    const index = item ? readIndex(item) : null
    if (index === null) return

    let letter: string | null = null
    let start = -1
    for (const [candidate, firstIndex] of letterFirstIndex()) {
      if (firstIndex <= index && firstIndex > start) {
        start = firstIndex
        letter = candidate
      }
    }
    onChange(letter)
  }

  // One recompute per frame at most: a scroll fires far more often than the
  // browser paints, and each pass walks the element stack.
  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(update)
  }

  // capture: true — the scroll may belong to a nested container rather than
  // the window, and scroll events do not bubble.
  window.addEventListener('scroll', schedule, { passive: true, capture: true })
  window.addEventListener('resize', schedule, { passive: true })
  schedule()

  return {
    update,
    stop() {
      window.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      if (frame) cancelAnimationFrame(frame)
    },
  }
}
