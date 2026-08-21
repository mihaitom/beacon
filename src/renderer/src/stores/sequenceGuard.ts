/** A monotonically increasing "am I still the latest?" guard — the shared
 * shape behind switchToIndex()'s and startCurrent()'s own seq counters in
 * playback.ts. Both call begin() once up front (before their first await)
 * and hold onto the returned token; after any await, isCurrent(token) tells
 * them whether a newer call has since superseded them, so a slow-to-resolve
 * older call can't stomp state a newer, already-successful one already
 * moved on from. */
export interface SequenceGuard {
  /** Bumps the guard and returns this call's token. */
  begin(): number
  /** Whether `token` (from an earlier begin()) is still the latest. */
  isCurrent(token: number): boolean
}

export function createSequenceGuard(): SequenceGuard {
  let current = 0
  return {
    begin() {
      return ++current
    },
    isCurrent(token) {
      return token === current
    },
  }
}
