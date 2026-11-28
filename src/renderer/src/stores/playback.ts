import { defineStore } from 'pinia'
import { calculateReplayGain } from '@/services/replayGain'
import { load as loadStreamQuality } from '@/services/streamQuality'
import { useConnectStore } from './connect'
import { useTransitionsStore } from './transitions'
import type { MixTransition } from '@/services/connect/types'
import type { Song } from '@/types/library'
import { isExternalSong } from '@/services/playback/preview'
import { isExternalSourceSong } from '@/services/connect/externalSource'
import {
  buildCastMixPayload,
  buildCastQualityPayload,
  buildCastQueuePayload,
} from '@/services/playback/castPayload'
import { clearPersistedPlayback } from '@/services/playback/persistence'
import { lifecycleActions } from './playback/lifecycle'
import { castActions } from './playback/cast'
import { transportActions } from './playback/transport'
import { radioActions } from './playback/radio'
import { localActions } from './playback/local'
import { previewActions } from './playback/preview'
import { queueActions } from './playback/queue'
import { settingsActions } from './playback/settings'
import type { PlaybackContext } from './playback/context'
import type { PlaybackState, QueueMoveTarget } from './playback/state'

// Re-exported for stores/auth.ts's logout, which has always reached for it
// here — see persistence.ts for what it does.
export { clearPersistedPlayback }

export type { QueueMoveTarget } from './playback/state'

// Share of the queue that has to carry a BPM tag before sorting by it is
// offered - "most of it", so the untagged rest piled up at the end stays a
// small part of the queue.
const BPM_SORT_MIN_TAGGED = 0.75

// The singleton bookkeeping in the action files and playback/shared.ts
// (endedEdge, the seq/keyed guards, persistTimer, ...) lives outside Pinia's
// own reactive state, so Vite's partial HMR doesn't know to reset or
// preserve it consistently — a live edit while a song's playing can leave a
// *new* module instance's fresh guard state racing against
// timers/subscriptions still running from the *old* one, which reads as
// impossible playback bugs (UI stuck on a track connect already advanced
// past, see the 2026-08-18 "stuck on Tinlicker" debugging session).
// hot.decline() used to be the direct way to opt a module out of HMR, but
// Vite removed it — self-accepting and immediately invalidating is the
// current replacement, forcing a full reload on any edit to this file, or
// to an action file, whose update stops here, instead of a partial
// hot-swap. Slower, but guarantees a clean, single-instance start every time.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot!.invalidate(
      'stores/playback.ts holds singleton state that cannot be safely hot-reloaded',
    )
  })
}

/**
 * Casting is a built-in playback target here, not an external interception
 * layer — every action (stores/playback/*.ts) checks `useConnectStore().isActive` itself and
 * either drives the shared AudioEngine (local) or the connect backend
 * (cast). Callers (views/components) always call this store directly and
 * never need to know which one is actually happening.
 */
export const usePlaybackStore = defineStore('playback', {
  state: (): PlaybackState => {
    // Read here rather than at module load so a fresh store (tests, a
    // second window) sees whatever is actually in storage now.
    const quality = loadStreamQuality()
    return {
      originalQueue: [],
      queue: [],
      moodMix: null,
      currentIndex: -1,
      isPlaying: false,
      castInterrupted: false,
      localPosition: 0,
      bufferedPosition: 0,
      mixNextLocked: false,
      mixTransitions: [],
      preview: null,
      duration: 0,
      volume: 1,
      shuffle: false,
      repeatMode: 'off',
      // 'off' by default — ReplayGain changes playback volume, which
      // shouldn't happen for existing users without them opting in first.
      replayGainMode: 'off',
      // Read straight out of storage rather than defaulted and restored
      // later: these decide the URL the very first startCurrent() builds,
      // and a restore landing after it would play one track at the wrong
      // quality on every app start.
      localQuality: quality.local,
      castQuality: quality.cast,
      activeLocalStream: null,
      radioStation: null,
      radioBuffering: false,
      radioConnectionLost: false,
      initialized: false,
    }
  },

  getters: {
    /** What positionTracker.extrapolate() may clamp the reported position
     * to — `duration` for a track, and nothing at all for a station.
     *
     * A live stream has no length, so there is nothing to clamp against;
     * `this.duration` while one is playing is whatever the last *track*
     * left behind. Clamping to that pins the "Live · {elapsed}" readout at
     * that track's length and holds it there for as long as the station
     * plays — a counter that looks like it froze, over audio that is
     * perfectly fine. Confirmed live 2026-09-06 with duration and
     * localPosition both sitting at exactly 170 on a station 15 minutes in.
     *
     * Asked here rather than fixed by clearing `duration` at each place a
     * station starts, which is what the first attempt at this did
     * (playRadioStation(), 2026-09-02). That left the same bug on every
     * other route to a playing station — pressing play on a restored one
     * (togglePlay), picking a cast target for one already playing
     * (castTo), and both hand-off paths — since none of those changes the
     * station and so none of them looked like it needed a reset. Deriving
     * it from "is a station playing" instead means no future path can
     * forget. */
    positionClamp(state): number {
      return state.radioStation ? 0 : state.duration
    },

    /** What is playing right now, or null.
     *
     * Null for as long as a radio station is playing, even though the
     * queue behind it is still fully intact — see playRadioStation() for
     * why a station interrupts the queue rather than replacing it. Every
     * consumer of this already asks "a song, or a station?" in exactly
     * that order (the player-bar labels, the seek bar, lyrics, the
     * waveform, scrobbling, the media-session metadata), so this one
     * getter is what keeps all of them right without any of them needing
     * to know the queue survived. Queue bookkeeping wants queuedSong
     * below instead. */
    currentSong(state): Song | null {
      // What is heard, the way a station is - see startPreview().
      if (state.preview)
        return state.preview.songs[state.preview.picks[state.preview.index]!] ?? null
      if (state.radioStation) return null
      return state.currentIndex >= 0 ? (state.queue[state.currentIndex] ?? null) : null
    },
    /** Whether what plays is a library song - not a station, not a
     * Deezer preview and not a song from the external source, none of which
     * the media server knows anything of. */
    currentSongInLibrary(): boolean {
      const song = this.currentSong
      return !!song && !isExternalSong(song) && !isExternalSourceSong(song)
    },
    /** Where the queue itself stands, station or no station — the song a
     * shuffle toggle re-pins around, "play next" inserts after and "clear
     * queue" keeps. Identical to currentSong whenever no station is
     * playing; the two only differ for the span of one. */
    queuedSong(state): Song | null {
      return state.currentIndex >= 0 ? (state.queue[state.currentIndex] ?? null) : null
    },
    /** The queue position the mix has settled on as the next song (see
     * mixNextLocked), or -1. Every queue edit keeps that song right after
     * the current one: connect no longer takes a change there, and a
     * queue showing something else next would be wrong the moment the
     * transition is heard. Not under repeat-one, where the mix plays the
     * current song again whatever comes next in the queue. */
    lockedNextIndex(state): number {
      if (!state.mixNextLocked || state.repeatMode === 'one' || state.radioStation) return -1
      const next = state.currentIndex + 1
      return next > 0 && next < state.queue.length ? next : -1
    },
    /** Whether sorting the queue by BPM (sortQueueByBpm) is worth offering:
     * only with DJ mixes on, where neighbouring tempos decide whether two
     * songs can be beatmixed, and only where most of the queue is tagged -
     * untagged songs all end up at the end, unsorted. */
    canSortByBpm(state): boolean {
      if (useTransitionsStore().mode !== 'crossfade' || state.queue.length < 2) return false
      const tagged = state.queue.filter((song) => song.bpm).length
      return tagged >= state.queue.length * BPM_SORT_MIN_TAGGED
    },
    /** The reorderQueue() target that moves the song at `from` to `where`,
     * or null where it is already there or must not move: the current
     * song, and a locked next one. */
    queueMoveTarget(): (from: number, where: QueueMoveTarget) => number | null {
      return (from, where) => {
        const last = this.queue.length - 1
        if (from < 0 || from > last) return null
        if (from === this.currentIndex || from === this.lockedNextIndex) return null
        let to: number
        if (where === 'end') {
          to = last
        } else {
          const insertBefore = Math.max(this.currentIndex, this.lockedNextIndex) + 1
          to = insertBefore > from ? insertBefore - 1 : insertBefore
        }
        return to === from ? null : to
      }
    },
    /** How the current song blends into the next, once the mix has
     * planned it - a crossfade's change comes before the song's own end. */
    upcomingTransition(state): MixTransition | null {
      const song = state.currentIndex >= 0 ? state.queue[state.currentIndex] : undefined
      if (!song || state.radioStation || state.preview) return null
      let found: MixTransition | null = null
      for (const transition of state.mixTransitions) {
        if (transition.song_id === song.id) found = transition
      }
      return found
    },
    /** The blend the current song came in with, still under way until the
     * song reaches its `end` - the previous song is heard under it from the
     * change until then. A song repeating into itself has none. */
    incomingTransition(state): MixTransition | null {
      const song = state.currentIndex >= 0 ? state.queue[state.currentIndex] : undefined
      if (!song || state.radioStation || state.preview) return null
      let found: MixTransition | null = null
      for (const t of state.mixTransitions) {
        if (t.next_song_id === song.id && t.song_id !== song.id && t.kind !== 'gapless') found = t
      }
      return found
    },
    hasNext(state): boolean {
      if (state.preview) return true // the next excerpt, or the end of it
      if (state.repeatMode !== 'off') return state.queue.length > 0
      return state.currentIndex < state.queue.length - 1
    },
    hasPrevious(state): boolean {
      if (state.queue.length === 0) return false
      return state.currentIndex > 0 || state.repeatMode === 'all'
    },
    isCasting(): boolean {
      return useConnectStore().isActive
    },
    /** The linear ReplayGain multiplier for `currentSong` under the user's
     * replayGainMode — 1 (no change) once there's no current song (radio
     * has no ReplayGain concept either way). Passed to
     * AudioEngine.play()/load() for local playback, and as connect/playback.ts's
     * `gain` option when starting/handing off a cast — same multiplier,
     * different consumer (a Web Audio GainNode vs. ffmpeg's `volume` filter,
     * see core/streamer.py). */
    replayGainMultiplier(): number {
      return this.currentSong ? calculateReplayGain(this.currentSong, this.replayGainMode) : 1
    },
    /** See buildCastQualityPayload(). */
    castQualityPayload(state): ReturnType<typeof buildCastQualityPayload> {
      return buildCastQualityPayload(state.castQuality)
    },
    /** See buildCastQueuePayload(). */
    castQueuePayload(state): ReturnType<typeof buildCastQueuePayload> {
      return buildCastQueuePayload(state)
    },
    /** See buildCastMixPayload(). */
    castMixPayload(state): ReturnType<typeof buildCastMixPayload> {
      return buildCastMixPayload(state)
    },
  },

  actions: {
    ...lifecycleActions,
    ...castActions,
    ...transportActions,
    ...radioActions,
    ...localActions,
    ...previewActions,
    ...queueActions,
    ...settingsActions,
  },
})

// The action files type `this` from PlaybackContext, written out by hand
// (see stores/playback/context.ts). This keeps it honest: the store Pinia
// builds has to still be one, or type-check fails here.
type MustBeTrue<T extends true> = T
export type StoreMatchesContext = MustBeTrue<
  ReturnType<typeof usePlaybackStore> extends PlaybackContext ? true : false
>
