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

export function createPositionTracker(): PositionTracker {
  let lastElapsed: number | null = null
  let lastElapsedAt = 0

  return {
    record(elapsed, now) {
      lastElapsed = elapsed
      lastElapsedAt = now
    },
    reset() {
      lastElapsed = null
    },
    hasAnchor() {
      return lastElapsed !== null
    },
    extrapolate(now, duration) {
      if (lastElapsed === null) return 0
      const value = lastElapsed + (now - lastElapsedAt) / 1000
      return duration ? Math.min(value, duration) : value
    },
  }
}
