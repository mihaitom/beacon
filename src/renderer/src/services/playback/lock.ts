/** A plain in-flight mutex — behind togglePlayInFlight and autoplayFetching
 * in stores/playback.ts, both the same "skip this call entirely if an
 * earlier one is still running" pattern: `if (lock.isLocked()) return;
 * lock.acquire(); try { ... } finally { lock.release() }`. Unlike
 * sequenceGuard/keyedGuard, there's nothing to distinguish a newer call
 * from an older one here — the whole point is that only one may ever run
 * at a time, full stop. */
export interface Lock {
  isLocked(): boolean
  acquire(): void
  release(): void
}

export function createLock(): Lock {
  let locked = false
  return {
    isLocked() {
      return locked
    },
    acquire() {
      locked = true
    },
    release() {
      locked = false
    },
  }
}
