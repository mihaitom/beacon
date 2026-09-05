// The chevron-dimming rule for a scrolling shelf, tested on its own rather
// than through either shelf component: both of them read it, and what it
// answers with is arithmetic on three numbers jsdom reports as zero — so a
// component test would only ever see the unmeasured case.
import { describe, expect, it, vi } from 'vitest'
import { observeShelfEdges, SHELF_EDGES_UNMEASURED, type ShelfEdges } from '../shelfScrollEdges'

/** A row element with the three numbers a browser would have laid out. */
function makeRow(box: { clientWidth: number; scrollWidth: number; scrollLeft: number }) {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: box.clientWidth, configurable: true })
  Object.defineProperty(el, 'scrollWidth', { value: box.scrollWidth, configurable: true })
  Object.defineProperty(el, 'scrollLeft', {
    value: box.scrollLeft,
    writable: true,
    configurable: true,
  })
  return el
}

function edgesOf(box: { clientWidth: number; scrollWidth: number; scrollLeft: number }) {
  const seen: ShelfEdges[] = []
  const watch = observeShelfEdges(makeRow(box), (edges) => seen.push(edges))
  watch.stop()
  return seen.at(-1)
}

describe('observeShelfEdges', () => {
  it('reports the left end reached at the start of the row', () => {
    expect(edgesOf({ clientWidth: 1000, scrollWidth: 3000, scrollLeft: 0 })).toEqual({
      atStart: true,
      atEnd: false,
    })
  })

  it('reports neither end mid-row', () => {
    expect(edgesOf({ clientWidth: 1000, scrollWidth: 3000, scrollLeft: 500 })).toEqual({
      atStart: false,
      atEnd: false,
    })
  })

  it('reports the right end reached at the far side', () => {
    expect(edgesOf({ clientWidth: 1000, scrollWidth: 3000, scrollLeft: 2000 })).toEqual({
      atStart: false,
      atEnd: true,
    })
  })

  /** A browser hands back a fractional scrollLeft after a smooth scroll, so
   * "the end" has to mean "within a pixel of it" — otherwise the right
   * chevron stays live on a row that cannot move any further. */
  it('counts a pixel short of the end as the end', () => {
    expect(edgesOf({ clientWidth: 1000, scrollWidth: 3000, scrollLeft: 1999.4 })?.atEnd).toBe(true)
  })

  it('reports both ends for a row too short to scroll', () => {
    expect(edgesOf({ clientWidth: 1000, scrollWidth: 800, scrollLeft: 0 })).toEqual({
      atStart: true,
      atEnd: true,
    })
  })

  /** Not "a shelf at both ends" — a shelf nothing has laid out. Answering
   * with a measurement of zero would dim both chevrons on every row until
   * the first scroll. */
  it('says nothing at all about a row that has no layout yet', () => {
    const onChange = vi.fn()
    observeShelfEdges(makeRow({ clientWidth: 0, scrollWidth: 0, scrollLeft: 0 }), onChange).stop()

    expect(onChange).not.toHaveBeenCalled()
    // Which leaves the caller on this, the state a fresh row is really in.
    expect(SHELF_EDGES_UNMEASURED).toEqual({ atStart: true, atEnd: false })
  })

  it('follows the row as it is scrolled', () => {
    const row = makeRow({ clientWidth: 1000, scrollWidth: 3000, scrollLeft: 0 })
    const seen: ShelfEdges[] = []
    const watch = observeShelfEdges(row, (edges) => seen.push(edges))

    row.scrollLeft = 500
    row.dispatchEvent(new Event('scroll'))
    row.scrollLeft = 2000
    row.dispatchEvent(new Event('scroll'))
    watch.stop()

    expect(seen).toEqual([
      { atStart: true, atEnd: false },
      { atStart: false, atEnd: false },
      { atStart: false, atEnd: true },
    ])
  })

  /** A scroll fires this per frame and the shelves re-check after every
   * render — an unconditional callback re-renders the component, which
   * re-checks, which re-renders. */
  it('stays quiet while nothing has changed', () => {
    const row = makeRow({ clientWidth: 1000, scrollWidth: 3000, scrollLeft: 500 })
    const onChange = vi.fn()
    const watch = observeShelfEdges(row, onChange)

    watch.refresh()
    row.dispatchEvent(new Event('scroll'))
    watch.stop()

    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('stops listening once told to', () => {
    const row = makeRow({ clientWidth: 1000, scrollWidth: 3000, scrollLeft: 0 })
    const onChange = vi.fn()
    observeShelfEdges(row, onChange).stop()
    onChange.mockClear()

    row.scrollLeft = 900
    row.dispatchEvent(new Event('scroll'))

    expect(onChange).not.toHaveBeenCalled()
  })
})
