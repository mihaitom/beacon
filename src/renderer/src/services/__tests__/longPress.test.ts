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
