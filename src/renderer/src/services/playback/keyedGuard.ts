/** The keyed counterpart to sequenceGuard.ts's numeric "am I still the
 * latest?" — for guards keyed by an identity that's already meaningful on
 * its own (a song id, a joined queue-id sequence) rather than an
 * auto-incrementing token. Behind adoptCastQueue()'s reconcilingQueueKey
 * and startCurrent()'s pendingLocalSongChange in stores/playback.ts:
 * begin(key) marks `key` as the one in flight; isCurrent(key) tells a
 * caller — either up front (skip starting duplicate work for a key already
 * in flight) or after an await (bail out if a *different* key has since
 * taken over) — whether `key` is still it; end(key) clears it, but only if
 * `key` is still the one in flight, so a stale call's cleanup can't stomp
 * a newer key's. */
export interface KeyedGuard<K> {
  /** Whether `key` is the one currently in flight/most recently begun. */
  isCurrent(key: K): boolean
  /** Whether any key at all is currently in flight. */
  hasAny(): boolean
  /** Marks `key` as now in flight. */
  begin(key: K): void
  /** Clears `key`, but only if it's still current — a no-op once a
   * different begin() has superseded it. */
  end(key: K): void
}

export function createKeyedGuard<K>(): KeyedGuard<K> {
  let current: K | null = null
  return {
    isCurrent(key) {
      return current === key
    },
    hasAny() {
      return current !== null
    },
    begin(key) {
      current = key
    },
    end(key) {
      if (current === key) current = null
    },
  }
}
