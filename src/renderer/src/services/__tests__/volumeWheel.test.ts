import { describe, expect, it } from 'vitest'
import { volumeAfterWheel } from '../volumeWheel'

/** A wheel notch as browsers actually report one: pixels by default,
 * whole lines in Firefox (deltaMode 1). Negative deltaY is "scroll up". */
function wheel(deltaY: number, deltaMode = 0): WheelEvent {
  return { deltaY, deltaMode } as WheelEvent
}

describe('volumeAfterWheel', () => {
  it('raises the volume scrolling up and lowers it scrolling down', () => {
    expect(volumeAfterWheel(wheel(-120), 50, 100, 0).volume).toBe(55)
    expect(volumeAfterWheel(wheel(120), 50, 100, 0).volume).toBe(45)
  })

  it('moves by 5% of whichever scale the slider is on', () => {
    // Local playback's 0-1 slider...
    expect(volumeAfterWheel(wheel(-120), 0.5, 1, 0).volume).toBe(0.55)
    // ...and a cast device's 0-100 one.
    expect(volumeAfterWheel(wheel(-120), 50, 100, 0).volume).toBe(55)
  })

  it('snaps an off-grid volume in the direction it is scrolled', () => {
    // 42% up is 45%, not 47% — but down is 40%, not 37%, so neither
    // direction overshoots past the nearest grid line.
    expect(volumeAfterWheel(wheel(-120), 42, 100, 0).volume).toBe(45)
    expect(volumeAfterWheel(wheel(120), 42, 100, 0).volume).toBe(40)
  })

  it('stays on the grid at the 0-1 scale instead of drifting on float error', () => {
    // 0.6 / 0.05 is 11.999999999999998, which without the epsilon costs a
    // step (0.6 -> 0.6 instead of 0.65).
    expect(volumeAfterWheel(wheel(-120), 0.6, 1, 0).volume).toBe(0.65)
    expect(volumeAfterWheel(wheel(120), 0.6, 1, 0).volume).toBe(0.55)
  })

  it('stops at both ends instead of running past them', () => {
    expect(volumeAfterWheel(wheel(-120), 98, 100, 0).volume).toBe(100)
    expect(volumeAfterWheel(wheel(-120), 100, 100, 0).volume).toBe(100)
    expect(volumeAfterWheel(wheel(120), 2, 100, 0).volume).toBe(0)
    expect(volumeAfterWheel(wheel(120), 0, 100, 0).volume).toBe(0)
  })

  it('moves exactly one step per event, however large the delta is', () => {
    // A notch is reported as anywhere from ~50 to 120 depending on
    // browser/OS; all of them are one step, not two or three.
    expect(volumeAfterWheel(wheel(-53), 50, 100, 0).volume).toBe(55)
    expect(volumeAfterWheel(wheel(-120), 50, 100, 0).volume).toBe(55)
    expect(volumeAfterWheel(wheel(-1000), 50, 100, 0).volume).toBe(55)
  })

  it('reads Firefox line-mode and page-mode deltas as scrolling too', () => {
    // deltaY of ±3 lines is one notch there — in pixels that would be far
    // below the threshold and do nothing at all.
    expect(volumeAfterWheel(wheel(-3, 1), 50, 100, 0).volume).toBe(55)
    expect(volumeAfterWheel(wheel(1, 2), 50, 100, 0).volume).toBe(45)
  })

  it('accumulates a trackpad’s small deltas until they add up to a step', () => {
    // A two-finger flick is a stream of tiny deltas — taking each one as a
    // full step would run the volume end to end in a single gesture.
    let carry = 0
    let volume: number | null = null
    for (let i = 0; i < 3; i++) {
      ;({ volume, carry } = volumeAfterWheel(wheel(-12), 50, 100, carry))
      expect(volume).toBeNull()
    }
    // 4 x 12 clears the threshold.
    ;({ volume, carry } = volumeAfterWheel(wheel(-12), 50, 100, carry))
    expect(volume).toBe(55)
    // Nothing is left over to fire the next event early.
    expect(carry).toBe(0)
  })

  it('drops unspent scroll when the direction reverses', () => {
    const down = volumeAfterWheel(wheel(30), 50, 100, 0)
    expect(down.volume).toBeNull()
    expect(down.carry).toBe(30)

    // Without the reset, this 30 up would first have to work off the 30
    // down, and the gesture would feel stuck.
    const up = volumeAfterWheel(wheel(-30), 50, 100, down.carry)
    expect(up.carry).toBe(-30)
    expect(up.volume).toBeNull()
    expect(volumeAfterWheel(wheel(-30), 50, 100, up.carry).volume).toBe(55)
  })
})
