/** Keeps the play queue on the media server (savePlayQueue), where other
 * apps - and Beacon on another device - can pick it up, and offers a
 * queue saved there elsewhere when this device comes back to it.
 *
 * Never over somebody else's: every save asks the server first, and where
 * it holds a queue another app or device saved since this one last did,
 * this device stops saving and offers that queue instead. It saves again
 * once the user has taken that queue over, or started something new here
 * (see markQueueReplaced()) - the same "whoever did something last" as
 * everywhere else, but only for something actually done.
 *
 * Nothing here plays: a queue taken over is loaded paused, and only after
 * the user asked for it. */

import { ref, watch } from 'vue'
import { emitter } from '@/emitter'
import { getLocale, i18n } from '@/i18n'
import { timeAgo } from '@/services/relativeTime'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import type { ServerPlayQueue } from '@/services/subsonic/client'
import {
  fingerprint,
  isForeign,
  loadMeta,
  sameQueue,
  saveMeta,
  serverSnapshot,
  shouldOffer,
  type QueueSnapshot,
  type ServerQueueMeta,
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
// The user started a new queue here (markQueueReplaced()): theirs to save
// even over a foreign one.
let replaced = false
let lastSaved: QueueSnapshot | null = null
// Mirrors ServerQueueMeta.savedFingerprint for when localStorage refuses
// the write - without it this device would take its own save for
// somebody else's and stop saving.
let savedFingerprint: string | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let lastCheckAt = 0
let byIndexFor: { account: string; byIndex: Promise<boolean> } | null = null
let lastRefreshAt = 0

// What the server holds, as far as this device last heard - from its own
// save or from asking. Undefined until it knows; null for no queue there.
// Only what decides whether the load button has anything to load.
const knownServer = ref<QueueSnapshot | null | undefined>(undefined)
// The drawer opening asks again, but not on every open and close.
const REFRESH_MIN_INTERVAL_MS = 10_000

function queueKey(songIds: string[], currentIndex: number): string {
  return `${currentIndex}|${songIds.join(',')}`
}

/** Called by the playback store each time it restores its local snapshot
 * (app start, account change). */
export function markQueueRestored(songIds: string[], currentIndex: number): void {
  restoredKey = queueKey(songIds, currentIndex)
  replaced = false
  lastSaved = null
  savedFingerprint = null
  knownServer.value = undefined
}

/** Called by the playback store when the user puts a whole new queue in
 * place (an album, a playlist, a radio) - a deliberate "now this", which
 * may replace a foreign queue on the server the way it replaces the old
 * one here. Edits to the queue already there don't count: that queue may
 * be the stale one the user hasn't got round to replacing yet. */
export function markQueueReplaced(): void {
  replaced = true
}

function meta(): ServerQueueMeta {
  const stored = loadMeta()
  return savedFingerprint === null ? stored : { ...stored, savedFingerprint }
}

function rememberInStep(snapshot: QueueSnapshot, isByIndex: boolean): void {
  lastSaved = snapshot
  knownServer.value = snapshot
  savedFingerprint = fingerprint(snapshot, isByIndex)
  saveMeta({ ...loadMeta(), savedFingerprint })
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

export async function saveServerQueue(): Promise<void> {
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
  const client = useLibraryStore().client()
  try {
    const isByIndex = await byIndex()
    if (!replaced) {
      const server = await client.getPlayQueue(isByIndex)
      knownServer.value = server && serverSnapshot(server)
      const current = meta()
      if (isForeign(server, snapshot, current, isByIndex)) {
        if (server.changed !== current.offeredChanged) {
          saveMeta({ ...current, offeredChanged: server.changed })
          offer(server)
        }
        return
      }
    }
    await client.savePlayQueue(snapshot.songIds, snapshot.currentIndex, snapshot.position, {
      byIndex: isByIndex,
    })
    rememberInStep(snapshot, isByIndex)
    // Once this device has saved, its queue is its own again.
    restoredKey = null
    replaced = false
  } catch (error) {
    console.warn('[serverQueue] Saving the queue failed:', error)
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveServerQueue(), SAVE_DEBOUNCE_MS)
}

/** Asks the server for its queue and offers it when somebody else saved it
 * and it is somewhere else. Not while something is playing here, or
 * casting: whoever is listening on this device is not asking to move -
 * saveServerQueue() offers it then, if it comes to that. */
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
  knownServer.value = server && serverSnapshot(server)
  const local = localSnapshot() ?? { songIds: [], currentIndex: -1, position: 0 }
  const current = meta()
  if (!shouldOffer(server, local, current, await byIndex())) return
  saveMeta({ ...current, offeredChanged: server.changed })
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
  // A cast may have started since the toast went up.
  if (usePlaybackStore().isCasting) return
  void take(server)
}

async function take(server: ServerPlayQueue): Promise<void> {
  usePlaybackStore().adoptServerQueue(server.songs, server.currentIndex, server.position)
  restoredKey = null
  replaced = false
  // Before the await, so a save landing meanwhile already sees this
  // device in step and has nothing to send.
  const snapshot = serverSnapshot(server)
  lastSaved = snapshot
  knownServer.value = snapshot
  // Taken, so in step with the server and not to be offered again.
  saveMeta({ ...meta(), offeredChanged: server.changed })
  rememberInStep(snapshot, await byIndex())
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
  knownServer.value = server && serverSnapshot(server)
  if (!server) {
    emitter.emit('toast', ['information', t('queue.serverLoad'), t('queue.serverEmpty')])
    return
  }
  await take(server)
}

/** Asks the server what it holds, for the load button - called as the
 * queue comes into view, since another device may have saved since. */
export async function refreshServerQueueState(): Promise<void> {
  if (!enabled()) return
  const now = Date.now()
  if (now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return
  lastRefreshAt = now
  try {
    const server = await useLibraryStore()
      .client()
      .getPlayQueue(await byIndex())
    knownServer.value = server && serverSnapshot(server)
  } catch (error) {
    console.warn('[serverQueue] Reading the queue failed:', error)
  }
}

export type ServerQueueLoadState = 'ready' | 'casting' | 'current' | 'empty'

/** The load button's tooltip for each state - why it is greyed out, where
 * it is. */
export const SERVER_QUEUE_LOAD_TITLES: Record<ServerQueueLoadState, string> = {
  ready: 'queue.serverLoad',
  casting: 'queue.serverLoadCasting',
  current: 'queue.serverLoadCurrent',
  empty: 'queue.serverLoadEmpty',
}

/** Whether the load button has something to do: 'current' when the
 * server holds the queue this device already has (or one at most a
 * periodic save behind it), 'empty' when it holds none. While it doesn't
 * know, it lets the button try. */
export function serverQueueLoadState(): ServerQueueLoadState {
  if (usePlaybackStore().isCasting) return 'casting'
  const server = knownServer.value
  if (server === null) return 'empty'
  const local = localSnapshot()
  if (server && local && sameQueue(server, local)) return 'current'
  return 'ready'
}

/** Call once, from App.vue. */
export function initServerQueueSync(): void {
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
  // Nothing on the way out: a save that cannot ask the server first could
  // overwrite a queue saved elsewhere since. A pause has already saved the
  // exact position; closing while playing loses at most one interval.
}
