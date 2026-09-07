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
import { accountScopedKey } from '@/services/accountKey'
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
    const raw = localStorage.getItem(accountScopedKey(PERSIST_KEY))
    return raw ? (JSON.parse(raw) as PersistedPlaybackState) : null
  } catch {
    return null
  }
}

export function savePersisted(snapshot: PersistedPlaybackState): void {
  try {
    localStorage.setItem(accountScopedKey(PERSIST_KEY), JSON.stringify(snapshot))
  } catch {
    // Storage full/unavailable — losing resume-on-reload is an acceptable
    // degradation, not worth surfacing to the user.
  }
}

// sessionStorage, deliberately not part of PersistedPlaybackState above —
// resumeLocalPlayback()'s decision to actually make sound needs to tell a
// reload apart from a genuine app restart, and localStorage can't do that on
// its own (it survives both identically). sessionStorage survives a reload
// of the same window/tab and is gone once that tab is closed. Read once,
// first thing, in restoreFromStorage(), before anything in this fresh
// instance's own life could overwrite it.
const SESSION_WAS_PLAYING_KEY = 'beacon.playback.session-was-playing'

// How recently playback has to have been running for this boot to count as
// a reload of it.
//
// The marker alone used to be the whole answer, on the reasoning that only
// a reload can leave sessionStorage behind. That is true of a desktop, and
// false of a phone: an installed PWA that goes into the background is
// discarded by the OS and *restored* later, which is the same tab as far as
// storage is concerned. Beacon read that as "the user reloaded" and started
// the station again by itself, in a pocket, hours later - reported
// 2026-09-07.
//
// A real reload is back within seconds, and the marker is rewritten on
// every persist while playback runs, so it is never older than the persist
// debounce. Anything past this window was the system restoring a page, not
// somebody reloading one.
const RESUME_WINDOW_MS = 30_000

export function readSessionWasPlaying(): boolean {
  try {
    const marked = Number(sessionStorage.getItem(SESSION_WAS_PLAYING_KEY))
    return marked > 0 && Date.now() - marked <= RESUME_WINDOW_MS
  } catch {
    return false
  }
}

/** Stamped with the moment rather than a flag - see RESUME_WINDOW_MS. */
export function writeSessionWasPlaying(wasPlaying: boolean): void {
  try {
    sessionStorage.setItem(SESSION_WAS_PLAYING_KEY, wasPlaying ? String(Date.now()) : '0')
  } catch {
    // Same acceptable degradation as savePersisted() above — worst case a
    // reload no longer resumes audio either, just like a restart already
    // doesn't.
  }
}

/** Called from authStore.logout() — the account signing in afterwards
 * shouldn't inherit the previous one's queue/position (whose stream URLs
 * wouldn't even be valid for a different account anyway). Now that
 * PERSIST_KEY is account-scoped, a *different* account logging in already
 * can't see this one's snapshot at all — but the account signing out is
 * still allowed to explicitly clear its own, e.g. the desktop's "log out
 * and forget me" case, so this stays. */
export function clearPersistedPlayback(): void {
  try {
    localStorage.removeItem(accountScopedKey(PERSIST_KEY))
  } catch {
    // Nothing to clean up if storage isn't available in the first place.
  }
}
