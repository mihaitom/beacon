import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/** The Remote Control's own copy of services/longPress.ts's pick-up
 * (connect/static/remote/js/long-press.js) - plain JS without a test
 * runner of its own, so it is driven from here with real DOM events. */

type OnLongPress = (
  element: HTMLElement,
  callback: () => void,
  pickUp?: { onLift: (lifted: boolean) => void; onDrag: (event: PointerEvent) => void },
) => void

let onLongPress: OnLongPress

beforeAll(async () => {
  const path = resolve(__dirname, '../../../../connect/static/remote/js/long-press.js')
  ;({ onLongPress } = await import(/* @vite-ignore */ pathToFileURL(path).href))
})

function pointer(element: HTMLElement, type: string, clientY = 0, pointerType = 'touch') {
  const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    pointerType,
    clientX: 0,
    clientY,
    button: 0,
  })
  element.dispatchEvent(event)
  return event
}

describe("the Remote Control's long press with a pick-up", () => {
  let row: HTMLElement
  let opened: ReturnType<typeof vi.fn<() => void>>
  let onLift: ReturnType<typeof vi.fn<(lifted: boolean) => void>>
  let onDrag: ReturnType<typeof vi.fn<(event: PointerEvent) => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    row = document.createElement('div')
    document.body.append(row)
    opened = vi.fn<() => void>()
    onLift = vi.fn<(lifted: boolean) => void>()
    onDrag = vi.fn<(event: PointerEvent) => void>()
    onLongPress(row, opened, { onLift, onDrag })
  })

  afterEach(() => {
    row.dispatchEvent(new Event('touchend'))
    row.remove()
    vi.useRealTimers()
  })

  function touchmoveScrolls(): boolean {
    const event = new Event('touchmove', { cancelable: true })
    row.dispatchEvent(event)
    return !event.defaultPrevented
  }

  it('lifts a held row and drags it once moved, holding the page still', () => {
    pointer(row, 'pointerdown', 100)
    expect(touchmoveScrolls()).toBe(true)
    vi.advanceTimersByTime(500)
    expect(onLift).toHaveBeenLastCalledWith(true)
    expect(touchmoveScrolls()).toBe(false)

    const move = pointer(row, 'pointermove', 140)

    expect(onDrag).toHaveBeenCalledWith(move)
    expect(touchmoveScrolls()).toBe(false)
    expect(opened).not.toHaveBeenCalled()
  })

  it('opens a lifted row let go without moving', () => {
    pointer(row, 'pointerdown')
    vi.advanceTimersByTime(500)
    pointer(row, 'pointerup')

    expect(opened).toHaveBeenCalledOnce()
    expect(onDrag).not.toHaveBeenCalled()
  })

  it('leaves a finger that moves before the hold to the scroll', () => {
    pointer(row, 'pointerdown', 100)
    pointer(row, 'pointermove', 140)
    vi.advanceTimersByTime(500)

    expect(onLift).not.toHaveBeenCalled()
    expect(onDrag).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
    expect(touchmoveScrolls()).toBe(true)
  })
})
