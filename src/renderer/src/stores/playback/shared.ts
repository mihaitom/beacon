/** Module-level state and helpers the playback store's action groups share. */
import { useLibraryStore } from '../library'
import type { Song } from '@/types/library'
import { emitter } from '@/emitter'
import { i18n } from '@/i18n'
import { createPositionTracker } from '@/services/playback/positionTracker'
import { createKeyedGuard } from '@/services/playback/keyedGuard'

// Store actions, not components — no this.$emitter/this.$t here, hence
// going straight to the underlying singletons those are thin wrappers
// around. Shared by startSongRadio()/startArtistRadio()/maybeAutoplay(),
// the only three callers of getSimilarSongs2() and so the only places
// SimilarSongs2Response's plexPassRequired flag can ever come back true
// (see that type's own comment) — `titleKey` is whichever of the three
// triggered it, so the toast reads as "Song Radio: needs Plex Pass" etc.
// rather than a single generic title.
export function notifyPlexPassRequired(titleKey: string): void {
  emitter.emit('toast', {
    level: 'information',
    title: i18n.global.t(titleKey),
    message: i18n.global.t('library.plexPassRequired'),
  })
}

// The seeds maybeAutoplay() already got nothing new for. Same question,
// same answer: without this, a library whose whole similar-songs pool is
// already in the queue is re-asked on every status tick — every ~2s while
// casting, since adoptCastQueue() calls the top-up on each one — for as
// long as the last song plays. A set rather than the single last-seed id
// it used to be, because the top-up now walks back through the queue for
// another seed (see maybeAutoplay) and has to remember each one it has
// already written off. Emptied wherever the queue is replaced outright.
export const autoplayExhaustedSeedIds = new Set<string>()

// Set while our own startCurrent() has told the connect backend to switch
// to a song but hasn't heard back yet — an SSE status tick can land in
// that gap still reporting the *previous* song (the backend hasn't
// processed our command yet), which reconcileFromStatus() would otherwise
// read as "a queue it doesn't recognize" and blow away the whole queue down
// to that one stale song. See reconcileFromStatus()'s early return (cast.ts).
export const localSongChangeGuard = createKeyedGuard<string>()

// Radio's own counterpart, keyed by stream URL. Same race, same shape: the
// station is switched here first and /play-url told about it afterwards, so
// an SSE tick landing in that gap still reports the *previous* station -
// which reconcileFromStatus() (cast.ts) would read as another client having
// switched this shared session, and switch back to it. Reported live
// 2026-09-06 as the new station appearing in the player bar, the old one
// replacing it, and the new one returning two seconds later. Not cosmetic:
// that branch also resets the now-playing tag and the title log, so every
// flip threw away what had already arrived for the station actually
// starting.
export const localRadioChangeGuard = createKeyedGuard<string>()

/** The songs for `ids`, in that order: from `known` (this client's own
 * objects - rows are keyed by them), the library, or the server. Null when
 * any lookup fails, rather than a list with a hole in it. */
export async function resolveSongs(
  ids: readonly string[],
  known: readonly Song[],
): Promise<Song[] | null> {
  const library = useLibraryStore()
  const knownById = new Map(known.map((song) => [song.id, song]))
  const resolvedById = new Map<string, Song>()
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const cached = knownById.get(id) ?? library.allSongs.find((song) => song.id === id)
      if (cached) {
        resolvedById.set(id, cached)
        return
      }
      try {
        resolvedById.set(id, await library.client().getSong(id))
      } catch (error) {
        console.error('[playback] Failed to resolve a song connect reported:', id, error)
      }
    }),
  )
  if (ids.some((id) => !resolvedById.has(id))) return null
  return ids.map((id) => resolvedById.get(id)!)
}

// Smooths cast playback's position — see positionTracker.ts's own comment
// for why and how. The status tick's position is server-authoritative and
// buffering-delay-calibrated (see connect/core/cast_position.py's
// apply_position_offset) — exactly what record() should anchor to.
export const positionTracker = createPositionTracker()

/** Module state more than one group of actions writes - plain `let`s
 * until the store was split, and an imported binding cannot be
 * reassigned. Outside Pinia's state on purpose, like the guards. */
export const runtime = {
  // The song id already registered as "played" (scrobble submission=true)
  // during the current play-through — guards checkScrobbleThreshold() against
  // submitting more than once per play, and naturally allows a re-scrobble
  // when the same song is played again later (a fresh startCurrent() resets
  // this to null first).
  scrobbledSongId: null as string | null,
  // How far the element holds the mix, in stream time. Kept rather than
  // mapped once, so followLocalMix() can map it into whichever song is
  // heard as one gives way to the next.
  mixBufferedEnd: 0,
  // Whether the sessionStorage marker read at boot (see SESSION_WAS_PLAYING_KEY
  // in services/playback/persistence.ts) says this is a reload of a session that was already playing — set
  // once by restoreFromStorage(), read once by resumeLocalPlayback().
  restoredWasPlaying: false,
  // The connection id of the relayed station playing locally, null for a
  // station fetched directly - see startLocalRadio() and wireAudioEngine()'s
  // onSilence.
  radioConnectionId: null as string | null,
}
