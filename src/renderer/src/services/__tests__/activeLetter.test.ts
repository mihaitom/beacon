import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeActiveLetter, type ActiveLetterHandle } from '../activeLetter'

/** The letters used across these tests: A starts at 0, B at 3, C at 10. */
const LETTERS = new Map([
  ['A', 0],
  ['B', 3],
  ['C', 10],
])

function itemAt(index: number): Element {
  const element = document.createElement('div')
  element.setAttribute('data-album-index', String(index))
  return element
}

/** Stands in for the browser's hit test — jsdom has none. */
function placeItem(element: Element | null): void {
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () =>
    element ? [element] : []
}

function observer(onChange: (letter: string | null) => void): ActiveLetterHandle {
  return observeActiveLetter({
    itemSelector: '[data-album-index]',
    readIndex: (item) => {
      const value = item.getAttribute('data-album-index')
      return value === null ? null : Number(value)
    },
    letterFirstIndex: () => LETTERS,
    onChange,
  })
}

afterEach(() => {
  delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint
})

describe('observeActiveLetter', () => {
  it('reports the letter whose run the item at the reference line falls in', () => {
    placeItem(itemAt(5))
    const seen: (string | null)[] = []
    const handle = observer((letter) => seen.push(letter))

    handle.update()

    expect(seen.at(-1)).toBe('B')
    handle.stop()
  })

  it('reports the first letter at the very top of the list', () => {
    placeItem(itemAt(0))
    const seen: (string | null)[] = []
    const handle = observer((letter) => seen.push(letter))

    handle.update()

    expect(seen.at(-1)).toBe('A')
    handle.stop()
  })

  it('reports the last letter once past its start', () => {
    placeItem(itemAt(999))
    const seen: (string | null)[] = []
    const handle = observer((letter) => seen.push(letter))

    handle.update()

    expect(seen.at(-1)).toBe('C')
    handle.stop()
  })

  it('leaves the letter alone when no item is under the reference line', () => {
    placeItem(null)
    const onChange = vi.fn()
    const handle = observer(onChange)

    handle.update()

    expect(onChange).not.toHaveBeenCalled()
    handle.stop()
  })

  it('recomputes on a scroll event', async () => {
    placeItem(itemAt(4))
    const seen: (string | null)[] = []
    const handle = observer((letter) => seen.push(letter))
    // The observer schedules its first pass; let it run before resetting.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    seen.length = 0

    window.dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

    expect(seen.at(-1)).toBe('B')
    handle.stop()
  })
})
