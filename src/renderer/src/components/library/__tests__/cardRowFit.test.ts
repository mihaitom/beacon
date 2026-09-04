import { afterEach, describe, expect, it, vi } from 'vitest'
import { cardsAcross, observeCardsAcross, skeletonsAcross } from '../cardRowFit'

describe('cardsAcross', () => {
  it('fits as many 160px cards as the width has room for', () => {
    // 160px cards with a 20px gap between them: three of those plus two
    // gaps is 520px exactly.
    expect(cardsAcross(520)).toBe(3)
    expect(cardsAcross(519)).toBe(2)
  })

  it('never answers with less than one card', () => {
    expect(cardsAcross(0)).toBe(1)
    expect(cardsAcross(-100)).toBe(1)
  })
})

describe('skeletonsAcross', () => {
  it('draws one more than fits, so the row reads as continuing', () => {
    // These rows scroll: placeholders that stop exactly at the edge look
    // like a complete shelf, while the content they stand in for does not.
    expect(skeletonsAcross(520)).toBe(cardsAcross(520) + 1)
  })
})

describe('observeCardsAcross', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports what fits right now, before any resize has happened', () => {
    // Synchronously, so the first paint already has the right number of
    // placeholders rather than growing into it a frame later.
    const el = { clientWidth: 900 } as Element
    const widths: number[] = []

    observeCardsAcross(el, (width) => widths.push(width))

    expect(widths).toEqual([900])
  })

  it('says nothing at all about a row that has not been laid out', () => {
    // Width zero is not a narrow shelf, it is a shelf nobody has measured
    // yet (a hidden tab, jsdom) — answering it would collapse the row to a
    // single placeholder.
    const el = { clientWidth: 0 } as Element
    const widths: number[] = []

    observeCardsAcross(el, (width) => widths.push(width))

    expect(widths).toEqual([])
  })

  it('keeps reporting as the row changes width', () => {
    let notify: (entries: { contentRect: { width: number } }[]) => void = () => {}
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: typeof notify) {
          notify = callback
        }
        observe(): void {}
        disconnect = disconnect
      },
    )
    const el = { clientWidth: 900 } as Element
    const widths: number[] = []

    const observer = observeCardsAcross(el, (width) => widths.push(width))
    notify([{ contentRect: { width: 1400 } }])
    notify([{ contentRect: { width: 0 } }])

    expect(widths).toEqual([900, 1400])
    observer?.disconnect()
    expect(disconnect).toHaveBeenCalled()
  })

  it('still measures once where there is no ResizeObserver to be had', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const el = { clientWidth: 900 } as Element
    const widths: number[] = []

    expect(observeCardsAcross(el, (width) => widths.push(width))).toBeNull()
    expect(widths).toEqual([900])
  })
})
