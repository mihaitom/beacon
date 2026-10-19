/** The decisions behind keeping the play queue on the server
 * (serverQueueSync.ts), kept free of store state so they can be tested on
 * their own, plus the little that is remembered about it on this device. */

import { accountScopedKey } from '@/services/accountKey'
import type { ServerPlayQueue } from '@/services/subsonic/client'

/** A queue as both sides describe it: song ids, which of them is current,
 * and how far into it (seconds). */
export interface QueueSnapshot {
  songIds: string[]
  currentIndex: number
  position: number
}

// Below this, two positions in the same song count as the same place - the
// server copy is only refreshed every SAVE_INTERVAL_MS while playing, so
// this device's own last save trails what it has itself by up to that much.
const SAME_POSITION_S = 45

export function sameQueue(
  a: QueueSnapshot,
  b: QueueSnapshot,
  positionTolerance = SAME_POSITION_S,
): boolean {
  return (
    a.currentIndex === b.currentIndex &&
    Math.abs(a.position - b.position) < positionTolerance &&
    a.songIds.length === b.songIds.length &&
    a.songIds.every((id, i) => id === b.songIds[i])
  )
}

export function serverSnapshot(queue: ServerPlayQueue): QueueSnapshot {
  return {
    songIds: queue.songs.map((song) => song.id),
    currentIndex: queue.currentIndex,
    position: queue.position,
  }
}

/** A fingerprint of exactly what was saved, to recognise this device's own
 * save when it comes back from the server - anything else there was
 * written by someone else. Exact rather than by timestamp: comparing the
 * server's clock with this device's would make a few seconds of skew decide
 * whose queue it is.
 *
 * The plain form keeps the current song as an id and hands back its first
 * copy, so there the id is what is compared, not the index. */
export function fingerprint(snapshot: QueueSnapshot, byIndex: boolean): string {
  const current = byIndex ? snapshot.currentIndex : snapshot.songIds[snapshot.currentIndex]
  const text = `${current}|${Math.round(snapshot.position * 1000)}|${snapshot.songIds.join(',')}`
  // FNV-1a: only told apart from the one fingerprint stored, so 32 bits
  // are plenty, and it keeps a long queue out of localStorage.
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** Whether the server holds a queue somebody else saved - not this
 * device's own last save - that is somewhere else than this device is. */
export function isForeign(
  server: ServerPlayQueue | null,
  local: QueueSnapshot,
  meta: ServerQueueMeta,
  byIndex: boolean,
): server is ServerPlayQueue {
  if (!server) return false
  const snapshot = serverSnapshot(server)
  if (fingerprint(snapshot, byIndex) === meta.savedFingerprint) return false
  return !sameQueue(snapshot, local)
}

/** Whether to offer a foreign queue in a toast: each one once. */
export function shouldOffer(
  server: ServerPlayQueue | null,
  local: QueueSnapshot,
  meta: ServerQueueMeta,
  byIndex: boolean,
): server is ServerPlayQueue {
  return isForeign(server, local, meta, byIndex) && server.changed !== meta.offeredChanged
}

export interface ServerQueueMeta {
  /** fingerprint() of what this device last saved, or last loaded - either
   * way the server copy it is in step with. */
  savedFingerprint: string
  /** The server's `changed` of the last queue offered here - each one is
   * offered once, not on every return to the window. */
  offeredChanged: number
}

const META_KEY = 'beacon.serverQueue'

export function loadMeta(): ServerQueueMeta {
  try {
    const raw = localStorage.getItem(accountScopedKey(META_KEY))
    const parsed = raw ? (JSON.parse(raw) as Partial<ServerQueueMeta>) : {}
    return {
      savedFingerprint: parsed.savedFingerprint ?? '',
      offeredChanged: parsed.offeredChanged ?? 0,
    }
  } catch {
    return { savedFingerprint: '', offeredChanged: 0 }
  }
}

export function saveMeta(meta: ServerQueueMeta): void {
  try {
    localStorage.setItem(accountScopedKey(META_KEY), JSON.stringify(meta))
  } catch {
    // Worst case a queue is offered once more than it needed to be, or this
    // device's own save reads as somebody else's until it saves again.
  }
}
