/** The two payloads this app sends connect when it starts or updates a
 * cast, built from playback state. Split out of stores/playback.ts because
 * both are pure derivations - they read state and the autoplay settings,
 * and change nothing - which also makes the queue-shape rules below
 * testable without standing up the whole store.
 *
 * Used by the getters of the same name in stores/playback.ts. */

import { AUTOPLAY_BATCH_SIZE, useAutoplayStore } from '@/stores/autoplay'
import type { StreamQuality, TranscodeFormat } from '@/services/streamQuality'
import type { Song } from '@/types/library'
import type { RepeatMode } from './types'

/** The cast quality ceiling in the shape connect's /play expects, or an
 * empty object when there is none — connect treats both fields missing
 * as "no ceiling" and behaves exactly as it did before they existed
 * (see resolve_output_format()), so spreading nothing is the correct
 * way to say "don't cap this". */
export function buildCastQualityPayload(castQuality: StreamQuality): {
  max_lossy_format?: TranscodeFormat
  max_lossy_bitrate_kbps?: number
} {
  if (castQuality.format === 'original') return {}
  return {
    max_lossy_format: castQuality.format,
    max_lossy_bitrate_kbps: castQuality.bitrate,
  }
}

/** The full queue (history included) + current index, plus the standing
 * shuffle/repeat/originalQueue preferences — everything
 * connectPlayback.play()/updateQueue() need to both drive connect's own
 * auto-advance and broadcast the same queue/now-playing/toggle-state to
 * every other client sharing this session (see
 * services/connect/playback.ts's own comments). fullQueue is truncated
 * to history+current (nothing after) under repeat-one: connect would
 * otherwise auto-advance straight past the very song the user asked to
 * loop, which only this renderer's own repeat-mode logic
 * (advanceOnSongEnd() below) knows to keep replaying instead — other
 * clients briefly not seeing "upcoming" while repeat-one is active is
 * an acceptable trade for that. Repeat-all's wraparound past the end of
 * the full list is a similar renderer-only case, left alone here — see
 * this store's own advanceOnSongEnd(). */
export function buildCastQueuePayload(state: {
  queue: Song[]
  originalQueue: Song[]
  currentIndex: number
  shuffle: boolean
  repeatMode: RepeatMode
}): {
  fullQueue: string[]
  queueIndex: number
  originalQueue: string[]
  shuffle: boolean
  repeatMode: RepeatMode
  autoplayEnabled: boolean
  autoplayBatchSize: number
} {
  const upToCurrent = state.queue.slice(0, state.currentIndex + 1)
  const songs = state.repeatMode === 'one' ? upToCurrent : state.queue
  // Told to connect alongside shuffle/repeatMode (not read back from
  // status the way those are — see adoptCastQueue()) purely so
  // routes/stream.py's own fallback top-up (maybeAutoplay()'s backend-
  // side counterpart, for whenever no frontend client is around to run
  // this one) knows the current setting without needing a whole
  // separate sync channel for it.
  const autoplay = useAutoplayStore()
  return {
    fullQueue: songs.map((t) => t.id),
    queueIndex: state.currentIndex,
    originalQueue: state.originalQueue.map((t) => t.id),
    shuffle: state.shuffle,
    repeatMode: state.repeatMode,
    autoplayEnabled: autoplay.enabled,
    autoplayBatchSize: AUTOPLAY_BATCH_SIZE,
  }
}
