/** Pure decision logic behind adoptCastQueue() in stores/playback.ts — tells
 * whether an incoming queue/originalQueue from a connect status tick
 * actually differs from what's already loaded locally, before
 * adoptCastQueue() does any of its own (async, per-song) resolution work. */

/** Same-length, same-order id comparison. */
export function idsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

export interface CastQueueDiff {
  /** Whether the remote queue already matches the local one — nothing to
   * rebuild. */
  queueMatches: boolean
  /** Whether the remote original_queue already matches the local one, or is
   * empty (see this function's own comment). */
  originalMatches: boolean
}

/** Compares a connect status tick's queue/original_queue (as plain id
 * lists) against what's already loaded locally. An empty remote
 * original_queue is treated as "nothing to adopt" rather than "adopt an
 * empty list" — a defensive guard against wiping the local originalQueue
 * from a payload that never meaningfully set one (shouldn't normally
 * happen — setQueue() always keeps the two in lockstep — but an empty
 * original_queue is never useful to adopt either way). */
export function diffCastQueue(
  local: { queue: string[]; originalQueue: string[] },
  remote: { queue: string[]; originalQueue: string[] },
): CastQueueDiff {
  return {
    queueMatches: idsEqual(local.queue, remote.queue),
    originalMatches:
      remote.originalQueue.length === 0 || idsEqual(local.originalQueue, remote.originalQueue),
  }
}
