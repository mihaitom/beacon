/** Keeps the play queue on the media server (savePlayQueue), where other
 * apps - and Beacon on another device - can pick it up, and offers a
 * queue saved there elsewhere when this device comes back to it.
 *
 * Saves only while the server copy is this device's own: its own last
 * save, or nothing at all. Every save asks the server first, and once
 * another app or device has saved there since, this device stops saving
 * and offers that queue instead. Only the user moves it on from there -
 * by loading that queue, or by saving over it by hand
 * (saveServerQueueByHand()). Either way the server copy is this device's
 * own again, and saving carries on as before, on the way out too.
 *
 * A queue another Beacon of the same account saved - the phone on the way
 * home, say - is not foreign in that sense but the same queue carried on
 * elsewhere: this device takes it over by itself when it comes back to it,
 * as long as nothing here would be lost by that (see checkServerQueue()).
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
import { readSessionWasPlaying } from './persistence'
import { APP_NAME, type ServerPlayQueue } from '@/services/subsonic/client'
import {
  fingerprint,
  isForeign,
  loadMeta,
  queueFingerprint,
  sameQueue,
  saveMeta,
  serverSnapshot,
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

// Whether the server held this device's own queue (or none) when this
// device last looked or saved. What lets the save on the way out go
// without asking first - it is the one save that can't.
let ours = false
let lastSaved: QueueSnapshot | null = null
// Mirrors ServerQueueMeta's two saved fingerprints for when localStorage
// refuses the write - without it this device would take its own save for
// somebody else's and stop saving.
let savedMirror: Pick<ServerQueueMeta, 'savedFingerprint' | 'savedQueue'> | null = null
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
 * (app start, account change): what was known about the server belonged to
 * the session before. */
export function markQueueRestored(): void {
  ours = false
  lastSaved = null
  savedMirror = null
  knownServer.value = undefined
}

function meta(): ServerQueueMeta {
  return { ...loadMeta(), ...savedMirror }
}

function rememberInStep(snapshot: QueueSnapshot, isByIndex: boolean): void {
  lastSaved = snapshot
  knownServer.value = snapshot
  ours = true
  savedMirror = {
    savedFingerprint: fingerprint(snapshot, isByIndex),
    savedQueue: queueFingerprint(snapshot),
  }
  saveMeta({ ...loadMeta(), ...savedMirror })
}

/** Whether the queue here has been edited since it was last saved or
 * loaded, without that edit reaching the server - what taking over
 * another Beacon's queue would throw away. Playing on doesn't count; an
 * empty queue has nothing to lose. */
function hasUnsavedEdits(): boolean {
  const local = localSnapshot()
  return local !== null && queueFingerprint(local) !== meta().savedQueue
}

/** Takes note of what the server just said it holds. */
function observe(server: ServerPlayQueue | null, isByIndex: boolean): void {
  const snapshot = server && serverSnapshot(server)
  knownServer.value = snapshot
  ours = !snapshot || fingerprint(snapshot, isByIndex) === meta().savedFingerprint
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

/** Whether it saved - false for nothing to save, a foreign queue in the
 * way, or a failure.
 *
 * `overwrite` saves without asking: the user's own decision by hand, or
 * `keepalive` on the way out, which only goes while the server copy was
 * this device's own a moment ago. */
export async function saveServerQueue({
  keepalive = false,
  overwrite = false,
} = {}): Promise<boolean> {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (!enabled()) return false
  const snapshot = localSnapshot()
  if (!snapshot) return false
  if (!overwrite && lastSaved && sameQueue(snapshot, lastSaved, 1)) return true
  const client = useLibraryStore().client()
  try {
    const isByIndex = await byIndex()
    if (!overwrite && !keepalive) {
      const server = await client.getPlayQueue(isByIndex)
      observe(server, isByIndex)
      const current = meta()
      if (isForeign(server, snapshot, current, isByIndex)) {
        if (server.changed !== current.offeredChanged) {
          saveMeta({ ...current, offeredChanged: server.changed })
          offer(server)
        }
        return false
      }
    }
    await client.savePlayQueue(snapshot.songIds, snapshot.currentIndex, snapshot.position, {
      byIndex: isByIndex,
      keepalive,
    })
    rememberInStep(snapshot, isByIndex)
    return true
  } catch (error) {
    console.warn('[serverQueue] Saving the queue failed:', error)
    return false
  }
}

/** The queue toolbar's save button: this device's queue onto the server
 * now, over a foreign one too - after which it is this device's own again
 * and the saving carries on by itself. */
export async function saveServerQueueByHand(): Promise<void> {
  if (!canSaveServerQueue()) return
  const t = i18n.global.t
  const saved = await saveServerQueue({ overwrite: true })
  emitter.emit(
    'toast',
    saved
      ? ['success', t('queue.serverSave'), t('queue.serverSaved')]
      : ['error', t('queue.serverSave'), t('queue.serverSaveFailed')],
  )
}

/** Whether the save button has anything to save. */
export function canSaveServerQueue(): boolean {
  return enabled() && localSnapshot() !== null
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveServerQueue(), SAVE_DEBOUNCE_MS)
}

/** Asks the server for its queue, and where somebody else saved it and it
 * is somewhere else: takes it over when another Beacon of this account
 * saved it and nothing here would be lost, offers it otherwise. Not while
 * something is playing here, or casting: whoever is listening on this
 * device is not asking to move - saveServerQueue() offers it then, if it
 * comes to that. */
export async function checkServerQueue({ force = false } = {}): Promise<void> {
  if (!enabled()) return
  const playback = usePlaybackStore()
  if (playback.isPlaying || playback.isCasting) return
  const now = Date.now()
  if (!force && now - lastCheckAt < CHECK_MIN_INTERVAL_MS) return
  lastCheckAt = now
  let server: ServerPlayQueue | null
  const isByIndex = await byIndex()
  try {
    server = await useLibraryStore().client().getPlayQueue(isByIndex)
  } catch (error) {
    console.warn('[serverQueue] Reading the queue failed:', error)
    return
  }
  observe(server, isByIndex)
  const local = localSnapshot() ?? { songIds: [], currentIndex: -1, position: 0 }
  const current = meta()
  if (!isForeign(server, local, current, isByIndex)) return
  // Re-checked: the request above may have taken long enough for
  // something to start.
  if (playback.isPlaying || playback.isCasting) return
  // Not on a reload of a window that was playing: it is about to carry on
  // by itself (resumeLocalPlayback()), and would carry on with this queue.
  if (server.changedBy === APP_NAME && !hasUnsavedEdits() && !readSessionWasPlaying()) {
    await take(server)
    announceTaken(server)
    return
  }
  if (server.changed === current.offeredChanged) return
  saveMeta({ ...current, offeredChanged: server.changed })
  offer(server)
}

function announceTaken(server: ServerPlayQueue): void {
  const t = i18n.global.t
  emitter.emit('toast', [
    'information',
    t('queue.serverSyncedTitle'),
    t('queue.serverSyncedMessage', { title: server.songs[server.currentIndex]?.title ?? '' }),
  ])
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
  const isByIndex = await byIndex()
  try {
    server = await useLibraryStore().client().getPlayQueue(isByIndex)
  } catch (error) {
    console.warn('[serverQueue] Reading the queue failed:', error)
    emitter.emit('toast', ['error', t('queue.serverLoad'), t('queue.serverLoadFailed')])
    return
  }
  observe(server, isByIndex)
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
    const isByIndex = await byIndex()
    observe(await useLibraryStore().client().getPlayQueue(isByIndex), isByIndex)
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
  // A desktop window left open never stops being visible - coming back to
  // it is a focus.
  window.addEventListener('focus', () => void checkServerQueue())

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
  // The last position before the window goes away. This one save cannot
  // ask the server first, so it only goes while the copy there was this
  // device's own when last seen - at most one interval ago while playing.
  window.addEventListener('pagehide', () => {
    if (ours && (saveTimer || playback.isPlaying)) void saveServerQueue({ keepalive: true })
  })
}
