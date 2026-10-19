/** Keeps the play queue on the media server (savePlayQueue), where other
 * apps - and Beacon on another device - can pick it up, and offers a
 * queue saved there elsewhere when this device comes back to it.
 *
 * Nothing here plays: a queue taken over is loaded paused, and only after
 * the user said so in the toast. */

import { watch } from 'vue'
import { emitter } from '@/emitter'
import { getLocale, i18n } from '@/i18n'
import { timeAgo } from '@/services/relativeTime'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import type { ServerPlayQueue } from '@/services/subsonic/client'
import {
  loadMeta,
  sameQueue,
  saveMeta,
  serverSnapshot,
  shouldOffer,
  type QueueSnapshot,
} from './serverQueue'

// Position only travels with these periodic saves while playing - a save
// per position tick would be several requests a second for nothing.
export const SAVE_INTERVAL_MS = 30_000
// Coalesces a burst of queue edits (a drag, several "play next"s) into one
// request.
const SAVE_DEBOUNCE_MS = 2_000
// Returning to the window asks the server again, but not on every
// alt-tab.
const CHECK_MIN_INTERVAL_MS = 60_000
// A question, not a report - see Toast.timeoutMs.
const OFFER_TIMEOUT_MS = 45_000

// The queue as restoreFromStorage() last put it in place. A device that
// was merely reopened must not push that snapshot - possibly days old -
// over a queue another device has saved since; only a change made here, or
// playing it, counts as this device having a say.
let restoredKey: string | null = null
let lastSaved: QueueSnapshot | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let lastCheckAt = 0
let byIndexFor: { account: string; byIndex: Promise<boolean> } | null = null

function queueKey(songIds: string[], currentIndex: number): string {
  return `${currentIndex}|${songIds.join(',')}`
}

/** Called by the playback store each time it restores its local snapshot
 * (app start, account change). */
export function markQueueRestored(songIds: string[], currentIndex: number): void {
  restoredKey = queueKey(songIds, currentIndex)
  lastSaved = null
}

function enabled(): boolean {
  const auth = useAuthStore()
  return auth.authenticated && auth.capabilities.serverQueue
}

/** What this device would save right now, or null where it has nothing to
 * say: an empty queue (clearing the server copy would wipe what another
 * app may still want), or a station playing over the queue. */
function localSnapshot(): QueueSnapshot | null {
  const playback = usePlaybackStore()
  if (playback.queue.length === 0 || playback.currentIndex < 0 || playback.radioStation) return null
  return {
    songIds: playback.queue.map((song) => song.id),
    currentIndex: playback.currentIndex,
    position: playback.preview ? playback.preview.resumeAt : playback.localPosition,
  }
}

/** indexBasedQueue where the server has it, so a song queued twice keeps
 * the right copy current; asked once per account. */
function byIndex(): Promise<boolean> {
  const auth = useAuthStore()
  const account = `${auth.serverUrl}|${auth.username}`
  if (byIndexFor?.account !== account) {
    const asked = useLibraryStore()
      .client()
      .getOpenSubsonicExtensions()
      .then((extensions) => extensions.has('indexBasedQueue'))
    byIndexFor = { account, byIndex: asked }
  }
  return byIndexFor.byIndex
}

export async function saveServerQueue({ keepalive = false } = {}): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (!enabled()) return
  const snapshot = localSnapshot()
  if (!snapshot) return
  const playback = usePlaybackStore()
  if (!playback.isPlaying && queueKey(snapshot.songIds, snapshot.currentIndex) === restoredKey) {
    return
  }
  if (lastSaved && sameQueue(snapshot, lastSaved, 1)) return
  try {
    await useLibraryStore()
      .client()
      .savePlayQueue(snapshot.songIds, snapshot.currentIndex, snapshot.position, {
        byIndex: await byIndex(),
        keepalive,
      })
    lastSaved = snapshot
    // Once this device has saved, its queue is its own again.
    restoredKey = null
    saveMeta({ ...loadMeta(), lastSavedAt: Date.now() })
  } catch (error) {
    console.warn('[serverQueue] Saving the queue failed:', error)
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveServerQueue(), SAVE_DEBOUNCE_MS)
}

/** Asks the server for its queue and offers it when it is newer than this
 * device's and somewhere else. Not while something is playing here, or
 * casting: whoever is listening on this device is not asking to move. */
export async function checkServerQueue({ force = false } = {}): Promise<void> {
  if (!enabled()) return
  const playback = usePlaybackStore()
  if (playback.isPlaying || playback.isCasting) return
  const now = Date.now()
  if (!force && now - lastCheckAt < CHECK_MIN_INTERVAL_MS) return
  lastCheckAt = now
  let server: ServerPlayQueue | null
  try {
    server = await useLibraryStore()
      .client()
      .getPlayQueue(await byIndex())
  } catch (error) {
    console.warn('[serverQueue] Reading the queue failed:', error)
    return
  }
  const local = localSnapshot() ?? { songIds: [], currentIndex: -1, position: 0 }
  const meta = loadMeta()
  if (!server || !shouldOffer(server, local, meta)) return
  saveMeta({ ...meta, offeredChanged: server.changed })
  offer(server)
}

function offer(server: ServerPlayQueue): void {
  const t = i18n.global.t
  const song = server.songs[server.currentIndex]
  emitter.emit('toast', {
    level: 'information',
    title: t('queue.serverOfferTitle'),
    message: t('queue.serverOfferMessage', {
      app: server.changedBy || t('queue.serverUnknownApp'),
      when: timeAgo(server.changed, Date.now(), getLocale()),
      title: song?.title ?? '',
      count: server.songs.length,
    }),
    timeoutMs: OFFER_TIMEOUT_MS,
    action: {
      label: t('queue.serverOfferAction'),
      onClick: () => adopt(server),
    },
  })
}

function adopt(server: ServerPlayQueue): void {
  const playback = usePlaybackStore()
  // Something may have started since the toast went up.
  if (playback.isPlaying || playback.isCasting) return
  take(server)
}

function take(server: ServerPlayQueue): void {
  usePlaybackStore().adoptServerQueue(server.songs, server.currentIndex, server.position)
  lastSaved = serverSnapshot(server)
  // Taken, so not to be offered again.
  saveMeta({ ...loadMeta(), offeredChanged: server.changed })
}

/** The queue toolbar's button: whatever the server holds, however old and
 * whoever saved it - the toast only offers what is new. Asked for, so it
 * replaces a queue that is playing too (loaded paused, like the toast's).
 * Not while casting: the speakers play connect's queue, not this one. */
export async function loadServerQueue(): Promise<void> {
  if (!enabled() || usePlaybackStore().isCasting) return
  const t = i18n.global.t
  let server: ServerPlayQueue | null
  try {
    server = await useLibraryStore()
      .client()
      .getPlayQueue(await byIndex())
  } catch (error) {
    console.warn('[serverQueue] Reading the queue failed:', error)
    emitter.emit('toast', ['error', t('queue.serverLoad'), t('queue.serverLoadFailed')])
    return
  }
  if (!server) {
    emitter.emit('toast', ['information', t('queue.serverLoad'), t('queue.serverEmpty')])
    return
  }
  take(server)
}

/** Call once, from App.vue. */
export function initServerQueueSync(): void {
  const auth = useAuthStore()
  const playback = usePlaybackStore()

  watch(
    () => enabled(),
    (on) => {
      if (on) void checkServerQueue({ force: true })
    },
  )
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkServerQueue()
  })

  watch(
    () =>
      `${playback.isPlaying}|${queueKey(
        playback.queue.map((song) => song.id),
        playback.currentIndex,
      )}`,
    () => scheduleSave(),
  )
  setInterval(() => {
    if (playback.isPlaying) void saveServerQueue()
  }, SAVE_INTERVAL_MS)
  // The last position before the window goes away - keepalive lets the
  // request outlive the page.
  window.addEventListener('pagehide', () => {
    if (auth.authenticated && (saveTimer || playback.isPlaying)) {
      void saveServerQueue({ keepalive: true })
    }
  })
}
