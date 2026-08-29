/** Everything stores/playback.ts keeps in browser storage, and nothing
 * else: the queue/position snapshot that lets a reload pick playback back
 * up, plus the separate sessionStorage marker that tells a reload apart
 * from a genuine restart. Pulled out of the store because none of it
 * touches store state - these are plain reads and writes, and every one of
 * them degrades to "do nothing" when storage is unavailable rather than
 * surfacing an error.
 *
 * Callers: the store itself (restoreFromStorage()/persistNow()) and
 * stores/auth.ts's logout, which clears the snapshot. */

import type { RadioStation, Song } from '@/types/library'
import type { ReplayGainMode } from '@/services/replayGain'
import type { RepeatMode } from './types'

// localStorage key for the persisted queue/position snapshot (see init()'s
// $subscribe and restoreFromStorage()) — lets a reload (or app restart)
// pick local playback back up close to where it left off, since a reload
// necessarily destroys the <audio> element and stops it for a moment.
const PERSIST_KEY = 'beacon.playback'

export interface PersistedPlaybackState {
  queue: Song[]
  originalQueue: Song[]
  currentIndex: number
  radioStation: RadioStation | null
  shuffle: boolean
  repeatMode: RepeatMode
  volume: number
  replayGainMode: ReplayGainMode
  localPosition: number
}

export function loadPersisted(): PersistedPlaybackState | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    return raw ? (JSON.parse(raw) as PersistedPlaybackState) : null
  } catch {
    return null
  }
}

export function savePersisted(snapshot: PersistedPlaybackState): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(snapshot))
  } catch {
    // Storage full/unavailable — losing resume-on-reload is an acceptable
    // degradation, not worth surfacing to the user.
  }
}

// sessionStorage, deliberately not part of PersistedPlaybackState above —
// resumeLocalPlayback()'s decision to actually make sound needs to tell a
// reload apart from a genuine app restart, and localStorage can't do that on
// its own (it survives both identically). sessionStorage is the platform's
// own answer to exactly this: it survives a reload of the same window/tab
// but is gone the moment that window/tab is closed, so it's only ever still
// there to read back if this boot is a reload of a session that was already
// running — never on a real restart (a fresh process/window/tab, Electron or
// web alike). Read once, first thing, in restoreFromStorage() below, before
// anything in this fresh instance's own life could overwrite it.
const SESSION_WAS_PLAYING_KEY = 'beacon.playback.session-was-playing'

export function readSessionWasPlaying(): boolean {
  try {
    return sessionStorage.getItem(SESSION_WAS_PLAYING_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeSessionWasPlaying(wasPlaying: boolean): void {
  try {
    sessionStorage.setItem(SESSION_WAS_PLAYING_KEY, String(wasPlaying))
  } catch {
    // Same acceptable degradation as savePersisted() above — worst case a
    // reload no longer resumes audio either, just like a restart already
    // doesn't.
  }
}

/** Called from authStore.logout() — a different Navidrome account signing
 * in afterwards shouldn't inherit the previous one's queue/position (whose
 * stream URLs wouldn't even be valid for the new account anyway). */
export function clearPersistedPlayback(): void {
  try {
    localStorage.removeItem(PERSIST_KEY)
  } catch {
    // Nothing to clean up if storage isn't available in the first place.
  }
}
