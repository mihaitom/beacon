import { describe, expect, it } from 'vitest'
import { STEPS_PER_SECOND, nextStep } from '../pacing'

/** How many steps one second of display frames at `hz` draws. */
function stepsIn(hz: number): number {
  let due = 0
  let steps = 0
  for (let frame = 0; frame < hz * 10; frame++) {
    const now = (frame * 1000) / hz
    const next = nextStep(now, due)
    if (next !== null) {
      due = next
      steps++
    }
  }
  return steps / 10
}

describe('nextStep', () => {
  it.each([60, 120, 144, 240])('holds a %i Hz display to 60 steps a second', (hz) => {
    expect(stepsIn(hz)).toBeCloseTo(STEPS_PER_SECOND, 0)
  })

  // An average of 60 is not enough there: skipping one frame and making
  // it up with the next would stutter.
  it('takes every frame of a 60 Hz display that arrives a little early or late', () => {
    let due = 0
    for (let frame = 0; frame < 600; frame++) {
      const now = (frame * 1000) / 60 + (frame % 2 ? 1 : -1)
      const next = nextStep(now, due)
      expect(next, `frame ${frame}`).not.toBeNull()
      due = next!
    }
  })

  it('draws every frame of a slower display, without bursts after', () => {
    expect(stepsIn(50)).toBe(50)
    expect(nextStep(10_000, 0)).toBe(10_000 - 100)
  })
})
