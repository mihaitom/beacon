/** The decisions behind keeping the play queue on the server
 * (stores/serverQueue.ts), kept free of store state so they can be tested
 * on their own, plus the little that is remembered about it on this
 * device. */

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

// Server and device clocks are compared directly (the server's `changed`
// against this device's last save), so a small skew between them must not
// make this device's own save look like somebody else's newer one.
const CLOCK_SKEW_MS = 10_000

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

/** Whether the server holds a queue worth offering in place of this
 * device's own: one saved after this device last saved, that this device
 * hasn't already offered, and that is somewhere else than this device is. */
export function shouldOffer(
  server: ServerPlayQueue | null,
  local: QueueSnapshot,
  meta: ServerQueueMeta,
): boolean {
  if (!server) return false
  if (server.changed <= meta.lastSavedAt + CLOCK_SKEW_MS) return false
  if (server.changed === meta.offeredChanged) return false
  return !sameQueue(serverSnapshot(server), local)
}

export interface ServerQueueMeta {
  /** When this device last saved its queue to the server (epoch ms). */
  lastSavedAt: number
  /** The server's `changed` of the last queue offered here - each one is
   * offered once, not on every return to the window. */
  offeredChanged: number
}

const META_KEY = 'beacon.serverQueue'

export function loadMeta(): ServerQueueMeta {
  try {
    const raw = localStorage.getItem(accountScopedKey(META_KEY))
    const parsed = raw ? (JSON.parse(raw) as Partial<ServerQueueMeta>) : {}
    return { lastSavedAt: parsed.lastSavedAt ?? 0, offeredChanged: parsed.offeredChanged ?? 0 }
  } catch {
    return { lastSavedAt: 0, offeredChanged: 0 }
  }
}

export function saveMeta(meta: ServerQueueMeta): void {
  try {
    localStorage.setItem(accountScopedKey(META_KEY), JSON.stringify(meta))
  } catch {
    // Worst case a queue is offered once more than it needed to be.
  }
}
