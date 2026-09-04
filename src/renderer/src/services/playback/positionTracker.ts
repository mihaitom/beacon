/** Smooths cast playback's server-reported position — which only ever moves
 * in ~2s jumps, as often as the connect backend's SSE status ticks (see
 * connect.$subscribe() in stores/playback.ts) — into something that can be read
 * every 200ms without visibly stuttering on the seek bar or leaving lyric
 * line highlighting up to ~2s behind the actual audio. record() anchors to
 * the last real (server-authoritative) position report; extrapolate()
 * advances forward from that anchor using wall-clock time elapsed since
 * then, the same way any client-side clock reconciled against a server
 * clock behaves. reset() drops the anchor entirely (e.g. a song change,
 * whose fresh position hasn't arrived yet) — extrapolating from a
 * *previous* song's last known elapsed would read as stale progress on the
 * new one, worse than just sitting still. */
export interface PositionTracker {
  /** Anchors extrapolation to a fresh authoritative position — a real SSE
   * status tick, or a seek that already knows where it landed. */
  record(elapsed: number, now: number): void
  /** Drops the current anchor. extrapolate() has nothing to extrapolate
   * from until the next record(). */
  reset(): void
  /** Whether record() has been called since the last reset()/creation —
   * extrapolate() is only meaningful once this is true. */
  hasAnchor(): boolean
  /** The current extrapolated position, clamped to `duration` (0 duration
   * — not yet known — extrapolates unclamped). Meaningless before the first
   * record(), see hasAnchor(). */
  extrapolate(now: number, duration: number): number
}

/** How far backwards a fresh server position may pull the displayed one
 * before it is taken at face value instead of being held.
 *
 * Small corrections that go the wrong way are ordinary noise: the backend's
 * own position-resync recalibrates `position_offset` against the device's
 * reported position (connect/routes/playback.py) and slews the correction
 * in over two seconds, so a status tick landing mid-slew legitimately reads
 * a little below the previous one. Letting those through makes the counter
 * visibly tick backwards for no reason a listener can act on.
 *
 * Anything larger is a real move — a seek, a track change, someone pressing
 * previous on the speaker's own remote — and must be followed immediately.
 * Comfortably above the backend's own POSITION_RESYNC_THRESHOLD (1.0s), so
 * a correction it considered worth applying is never swallowed here. */
const MAX_SMOOTHED_REWIND_SECONDS = 1.5

/** How long the display takes to give a swallowed backwards correction back
 * — i.e. to converge onto the authoritative position again after having been
 * held ahead of it.
 *
 * Swallowing such a correction *without* ever giving it back is what the
 * first version of this did (it re-anchored at the held value and dropped the
 * reported one entirely), and that made the display permanently that much
 * ahead of the backend: every following tick then read as another small
 * backwards correction of the same size, got held for the same reason, and
 * kept the lead alive indefinitely. It grew with every further correction
 * until it crossed MAX_SMOOTHED_REWIND_SECONDS, at which point one tick was
 * taken at face value and the counter jumped visibly backwards — the seek
 * bar's own "jumps back every so often, and a reload fixes it" (a reload
 * starts over with no lead), dragging the lyrics highlight back a line with
 * it.
 *
 * Matches _OFFSET_SLEW_SECONDS (connect/core/playback_clock.py), which is the
 * window the backend itself slews a recalibrated position_offset in over —
 * so a correction it spreads across two seconds is absorbed here across the
 * same two, rather than outliving it. Long enough that the slowdown isn't
 * readable as such: catching a full MAX_SMOOTHED_REWIND_SECONDS back down
 * over this window still leaves the counter moving forwards at a quarter
 * speed, never stalled and never backwards. */
const CATCH_UP_SECONDS = 2.0

export function createPositionTracker(): PositionTracker {
  let lastElapsed: number | null = null
  let lastElapsedAt = 0
  // How far ahead of the anchor the display is currently being held, and
  // when that lead was taken on — see record() and CATCH_UP_SECONDS.
  let lead = 0
  let leadAt = 0

  /** Whatever is left of the held lead, decaying linearly to nothing over
   * CATCH_UP_SECONDS. */
  const remainingLead = (now: number): number => {
    if (lead === 0) return 0
    const progress = (now - leadAt) / 1000 / CATCH_UP_SECONDS
    return progress >= 1 ? 0 : lead * (1 - progress)
  }

  /** The displayed position: the anchor advanced by wall-clock time, plus
   * whatever lead is still being carried. */
  const positionAt = (now: number, elapsed: number): number =>
    elapsed + (now - lastElapsedAt) / 1000 + remainingLead(now)

  return {
    record(elapsed, now) {
      // Hold, rather than snap back, for a small backwards correction —
      // see MAX_SMOOTHED_REWIND_SECONDS. Compared against the *displayed*
      // position, not the last recorded one: that's the number actually on
      // screen, and it has kept advancing since the previous tick.
      //
      // The backend's own _OffsetTrackerClock (connect/core/visualizer_feed.py)
      // has this same rule for the same reason — the cast visualizer's clock
      // never follows a poll backwards either. This side had no equivalent, so
      // every backwards correction reached the seek bar unfiltered.
      //
      // The reported value still becomes the anchor either way: the
      // difference is carried as a separate, decaying lead (see
      // CATCH_UP_SECONDS) rather than folded into the anchor itself, so the
      // display keeps moving forwards *and* converges back onto what the
      // backend actually says instead of staying ahead of it forever.
      if (lastElapsed !== null) {
        const rewind = positionAt(now, lastElapsed) - elapsed
        lead = rewind > 0 && rewind <= MAX_SMOOTHED_REWIND_SECONDS ? rewind : 0
        leadAt = now
      }
      lastElapsed = elapsed
      lastElapsedAt = now
    },
    reset() {
      lastElapsed = null
      lead = 0
    },
    hasAnchor() {
      return lastElapsed !== null
    },
    extrapolate(now, duration) {
      if (lastElapsed === null) return 0
      const value = positionAt(now, lastElapsed)
      return duration ? Math.min(value, duration) : value
    },
  }
}
