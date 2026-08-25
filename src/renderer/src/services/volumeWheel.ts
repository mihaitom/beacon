/** Mouse-wheel volume control, shared by every volume slider (the player
 * toolbar's, the connect picker's per-device rows, and the mobile web UI's
 * own two) so they all move by the same amount and agree on how much of a
 * scroll counts as one step. */

/** One step moves the volume by 5% of the slider's own range, whichever
 * scale it happens to be on — 0-1 for local playback, 0-100 for a cast
 * device. */
const STEP_FRACTION = 0.05

/** How much scrolling has to add up before it counts as a step. One notch
 * of a real mouse wheel clears this on its own (browsers report anywhere
 * from ~50 to 120 per notch); a trackpad, which fires a stream of much
 * smaller deltas, has to accumulate a few of them first — without that,
 * a single flick of two fingers would run the volume from silent to full. */
const STEP_THRESHOLD = 40

/** Wheel deltas don't have to be in pixels: Firefox reports whole lines
 * (deltaY of ±3 per notch), and page-scroll mode exists as well. Both are
 * converted to a rough pixel equivalent so STEP_THRESHOLD means the same
 * thing everywhere. */
const PIXELS_PER_LINE = 16
const PIXELS_PER_PAGE = 400

function toPixels(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * PIXELS_PER_LINE
  if (event.deltaMode === 2) return event.deltaY * PIXELS_PER_PAGE
  return event.deltaY
}

/**
 * The volume a wheel event leaves the slider at, or null while the scroll
 * so far hasn't added up to a full step yet. `carry` is that unspent
 * scroll: keep it on the component and hand the same field back in on the
 * next event.
 *
 * The result is snapped to the 5% grid *in the scroll's own direction*, so
 * a slider sitting at 42% goes to 45% up / 40% down rather than jumping by
 * a full step from an off-grid value.
 */
export function volumeAfterWheel(
  event: WheelEvent,
  current: number,
  max: number,
  carry: number,
): { volume: number | null; carry: number } {
  const delta = toPixels(event)
  // A reversal starts over rather than first having to work off scroll
  // that was headed the other way.
  const total = carry !== 0 && Math.sign(delta) !== Math.sign(carry) ? delta : carry + delta
  if (Math.abs(total) < STEP_THRESHOLD) return { volume: null, carry: total }

  // Exactly one step per event, no matter how big the delta was: a fast
  // spin is already several events, while a single notch reported as 120
  // shouldn't move three times as far as one reported as 53. Whatever is
  // left over is dropped for the same reason — carrying it would make the
  // very next event fire early.
  const steps = total < 0 ? 1 : -1 // scrolling up (negative deltaY) is louder
  const stepSize = max * STEP_FRACTION
  // The epsilon absorbs float error (0.6 / 0.05 is 11.999999999999998),
  // which would otherwise cost a step whenever the current value came out
  // just below a grid line.
  const grid = current / stepSize
  const from = steps > 0 ? Math.floor(grid + 1e-6) : Math.ceil(grid - 1e-6)
  const next = (from + steps) * stepSize
  const clamped = Math.min(max, Math.max(0, next))
  return { volume: Number(clamped.toFixed(4)), carry: 0 }
}
