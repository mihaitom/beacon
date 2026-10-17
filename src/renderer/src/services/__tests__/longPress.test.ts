import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LONG_PRESS_MS, LongPress } from '../longPress'

function pointer(pointerType: string, clientX = 0, clientY = 0) {
  return { pointerType, clientX, clientY } as PointerEvent
}

describe('LongPress', () => {
  let opened: ReturnType<typeof vi.fn<() => void>>
  let press: LongPress

  beforeEach(() => {
    vi.useFakeTimers()
    opened = vi.fn<() => void>()
    press = new LongPress(opened)
  })

  afterEach(() => {
    press.dispose()
    vi.useRealTimers()
  })

  function clickReaches(): boolean {
    const target = document.createElement('button')
    document.body.append(target)
    let reached = false
    target.addEventListener('click', () => (reached = true))
    target.click()
    target.remove()
    return reached
  }

  it('opens after a touch is held still', () => {
    press.down(pointer('touch'))
    vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    expect(opened).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(opened).toHaveBeenCalledOnce()
  })

  it('tolerates a wobble but not a scroll', () => {
    press.down(pointer('touch', 100, 100))
    press.move(pointer('touch', 104, 105))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(opened).toHaveBeenCalledOnce()

    press.down(pointer('touch', 100, 100))
    press.move(pointer('touch', 100, 130))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(opened).toHaveBeenCalledOnce()
  })

  it('does nothing for a touch released early', () => {
    press.down(pointer('touch'))
    press.cancel()
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(opened).not.toHaveBeenCalled()
  })

  it('leaves a held mouse button alone and opens on a right click', () => {
    press.down(pointer('mouse'))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(opened).not.toHaveBeenCalled()

    const event = new Event('contextmenu', { cancelable: true })
    press.contextMenu(event)
    expect(opened).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
  })

  /** Android fires its own contextmenu on a long press, racing the timer. */
  it('opens once when contextmenu and the timer both arrive', () => {
    press.down(pointer('touch'))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    press.contextMenu(new Event('contextmenu', { cancelable: true }))
    expect(opened).toHaveBeenCalledOnce()

    press.down(pointer('touch'))
    press.contextMenu(new Event('contextmenu', { cancelable: true }))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(opened).toHaveBeenCalledTimes(2)
  })

  /** It would play the row, or land on the sheet that just opened under
   * the finger and close it again. */
  it('swallows the click the released finger makes, and only that one', () => {
    press.down(pointer('touch'))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    window.dispatchEvent(new Event('pointerup'))
    expect(clickReaches()).toBe(false)
    expect(clickReaches()).toBe(true)
  })

  it('stops guarding shortly after a release that made no click', () => {
    press.down(pointer('touch'))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    window.dispatchEvent(new Event('pointerup'))
    vi.advanceTimersByTime(1000)
    expect(clickReaches()).toBe(true)
  })

  it('swallows nothing after a plain tap or a right click', () => {
    press.down(pointer('touch'))
    press.cancel()
    expect(clickReaches()).toBe(true)

    press.down(pointer('mouse'))
    window.dispatchEvent(new Event('pointerup'))
    press.contextMenu(new Event('contextmenu', { cancelable: true }))
    expect(clickReaches()).toBe(true)
  })
})

describe('LongPress with a pick-up', () => {
  let opened: ReturnType<typeof vi.fn<() => void>>
  let onLift: ReturnType<typeof vi.fn<(lifted: boolean) => void>>
  let onDrag: ReturnType<typeof vi.fn<(event: PointerEvent) => void>>
  let enabled: boolean
  let press: LongPress
  let row: HTMLElement

  beforeEach(() => {
    vi.useFakeTimers()
    opened = vi.fn<() => void>()
    onLift = vi.fn<(lifted: boolean) => void>()
    onDrag = vi.fn<(event: PointerEvent) => void>()
    enabled = true
    press = new LongPress(opened, { enabled: () => enabled, onLift, onDrag })
    row = document.createElement('div')
    document.body.append(row)
    press.bindScrollBlock(row)
  })

  afterEach(() => {
    press.dispose()
    row.remove()
    vi.useRealTimers()
  })

  function on(target: HTMLElement, pointerType: string, clientX = 0, clientY = 0, button = 0) {
    return {
      pointerType,
      clientX,
      clientY,
      button,
      currentTarget: target,
    } as unknown as PointerEvent
  }

  function touchmoveScrolls(): boolean {
    const event = new Event('touchmove', { cancelable: true })
    row.dispatchEvent(event)
    return !event.defaultPrevented
  }

  it('lifts a held row, and drags it once moved', () => {
    press.down(on(row, 'touch', 100, 100))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(onLift).toHaveBeenLastCalledWith(true)

    const move = on(row, 'touch', 100, 140)
    press.move(move)

    expect(onDrag).toHaveBeenCalledWith(move)
    expect(onLift).toHaveBeenLastCalledWith(false)
    expect(opened).not.toHaveBeenCalled()
  })

  it('opens a lifted row released without moving', () => {
    press.down(on(row, 'touch'))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(opened).not.toHaveBeenCalled()

    press.up()

    expect(opened).toHaveBeenCalledOnce()
    expect(onLift).toHaveBeenLastCalledWith(false)
    expect(onDrag).not.toHaveBeenCalled()
  })

  /** A finger that moves straight away is scrolling the list. */
  it('leaves a finger that moves before the hold to the scroll', () => {
    press.down(on(row, 'touch', 100, 100))
    press.move(on(row, 'touch', 100, 140))
    expect(touchmoveScrolls()).toBe(true)
    vi.advanceTimersByTime(LONG_PRESS_MS)

    expect(onLift).not.toHaveBeenCalled()
    expect(onDrag).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
  })

  it('holds the page still under a lifted or dragged row, until the finger lifts', () => {
    press.down(on(row, 'touch', 100, 100))
    expect(touchmoveScrolls()).toBe(true)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(touchmoveScrolls()).toBe(false)

    press.move(on(row, 'touch', 100, 140))
    expect(touchmoveScrolls()).toBe(false)

    row.dispatchEvent(new Event('touchend'))
    expect(touchmoveScrolls()).toBe(true)
  })

  /** Android's own long-press contextmenu can beat the timer. */
  it('lifts rather than opens on an early contextmenu', () => {
    press.down(on(row, 'touch'))
    press.contextMenu(new Event('contextmenu', { cancelable: true }))

    expect(onLift).toHaveBeenLastCalledWith(true)
    expect(opened).not.toHaveBeenCalled()
  })

  it('drags with a mouse as soon as it moves, and still opens on a right click', () => {
    press.down(on(row, 'mouse', 100, 100))
    press.move(on(row, 'mouse', 100, 140))
    expect(onDrag).toHaveBeenCalledOnce()
    press.up()

    press.down(on(row, 'mouse', 0, 0, 2))
    press.contextMenu(new Event('contextmenu', { cancelable: true }))
    expect(opened).toHaveBeenCalledOnce()
  })

  /** A row that cannot move stays a plain long press. */
  it('opens straight away when picking up is off for this press', () => {
    enabled = false
    press.down(on(row, 'touch'))
    vi.advanceTimersByTime(LONG_PRESS_MS)

    expect(opened).toHaveBeenCalledOnce()
    expect(onLift).not.toHaveBeenCalled()
  })
})
