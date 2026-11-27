// Milkdrop moves its picture per frame, not per second: a preset's zoom,
// spin and decay are steps, tuned for about 60 of them a second. Drawn at a
// 144 Hz display's rate it runs 2.4 times too fast, at 30 half as fast - so
// it is held to 60 whatever the display does.
export const STEPS_PER_SECOND = 60
const STEP_MS = 1000 / STEPS_PER_SECOND
// A 60 Hz display's frames arrive a hair early or late; without slack each
// early one would be skipped, halving the rate.
const SLACK_MS = 2
// A display slower than 60 Hz can only fall behind; this keeps the backlog
// from piling up into a burst once it catches up.
const MAX_BEHIND_MS = 100

/** When the step after this one is due, or null when this display frame
 * draws nothing. Due times rather than "time since the last frame", so a
 * 144 Hz display averages 60 (every second or third frame) instead of
 * rounding to 72. */
export function nextStep(now: number, dueAt: number): number | null {
  if (now < dueAt - SLACK_MS) return null
  return Math.max(dueAt + STEP_MS, now - MAX_BEHIND_MS)
}
