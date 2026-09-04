import { defineStore } from 'pinia'
import { getAudioEngine } from '@/services/audioEngine'
import { calculateReplayGain, type ReplayGainMode } from '@/services/replayGain'
import {
  bitrateFor,
  load as loadStreamQuality,
  save as saveStreamQuality,
  plan,
  type LocalStreamPlan,
  type StreamFormat,
  type StreamQuality,
} from '@/services/streamQuality'
import { useLibraryStore } from './library'
import { useConnectStore } from './connect'
import { useAuthStore } from './auth'
import { useAutoplayStore } from './autoplay'
import { useRadioSettingsStore } from './radioSettings'
import { useDrawersStore } from './drawers'
import * as connectPlayback from '@/services/connect/playback'
import type { ConnectDeviceRef, ConnectStatus, PlayResponse } from '@/services/connect/types'
import type { Artist, RadioStation, Song } from '@/types/library'
import { emitter } from '@/emitter'
import { i18n } from '@/i18n'
import { initMediaSession } from '@/services/mediaSession'
import { createPositionTracker } from '@/services/playback/positionTracker'
import { createSequenceGuard } from '@/services/playback/sequenceGuard'
import { createKeyedGuard } from '@/services/playback/keyedGuard'
import { createLock } from '@/services/playback/lock'
import { createEdgeDetector } from '@/services/playback/edgeDetector'
import { diffCastQueue } from '@/services/playback/queueReconcile'
import type { RepeatMode } from '@/services/playback/types'
import { resolveRadioStation } from '@/services/playback/radioStation'
import {
  fetchRadioMetadata,
  startRadioMetadataWatch,
  stopRadioMetadataWatch,
} from '@/services/connect/radioMetadata'
import { resolveRadioStreamUrl } from '@/services/connect/radio'
import { pollingAllowed } from '@/services/connect/pollGate'
import { buildCastQualityPayload, buildCastQueuePayload } from '@/services/playback/castPayload'
import {
  clearPersistedPlayback,
  loadPersisted,
  readSessionWasPlaying,
  savePersisted,
  writeSessionWasPlaying,
} from '@/services/playback/persistence'

// Re-exported for stores/auth.ts's logout, which has always reached for it
// here — see persistence.ts for what it does.
export { clearPersistedPlayback }

// Store actions, not components — no this.$emitter/this.$t here, hence
// going straight to the underlying singletons those are thin wrappers
// around. Shared by startSongRadio()/startArtistRadio()/maybeAutoplay(),
// the only three callers of getSimilarSongs2() and so the only places
// SimilarSongs2Response's plexPassRequired flag can ever come back true
// (see that type's own comment) — `titleKey` is whichever of the three
// triggered it, so the toast reads as "Song Radio: needs Plex Pass" etc.
// rather than a single generic title.
function notifyPlexPassRequired(titleKey: string): void {
  emitter.emit('toast', {
    level: 'information',
    title: i18n.global.t(titleKey),
    message: i18n.global.t('library.plexPassRequired'),
  })
}

interface PlaybackState {
  originalQueue: Song[]
  queue: Song[]
  currentIndex: number
  isPlaying: boolean
  /** A cast device dropped out on its own and playback can be picked back
   * up (see notifyCastInterrupted). Cleared once someone does, or once
   * playback is dispatched or stopped by any other route. */
  castInterrupted: boolean
  localPosition: number
  /** How far the current local stream is buffered ahead of localPosition —
   * see services/audioEngine.ts's onBufferedChange for how this is
   * derived. Always 0 while casting, which buffers on the device itself,
   * out of this app's reach. */
  bufferedPosition: number
  duration: number
  volume: number
  shuffle: boolean
  repeatMode: RepeatMode
  replayGainMode: ReplayGainMode
  /** Quality ceilings for this device's own player and for casting — see
   * services/streamQuality.ts for why both are caps rather than fixed
   * choices, and why they are two settings and not one. */
  localQuality: StreamQuality
  castQuality: StreamQuality
  /** What the currently loaded local stream actually is, and why — null
   * when nothing is loaded. Distinct from `localQuality` above in two
   * ways, both of which the stream-info panel depends on:
   *
   * - That one is the *setting*, and a setting change only takes effect at
   *   the next song start (see setLocalQuality()), so the running stream
   *   can legitimately be something else for the rest of a track.
   * - The setting is a ceiling, so a track already under it plays
   *   untouched even though the setting names a format (see plan() in
   *   services/streamQuality.ts).
   */
  activeLocalStream: LocalStreamPlan | null
  radioStation: RadioStation | null
  /** The current station's own ICY "now playing" tag (services/connect/
   * radioMetadata.ts) — null both before the backend's watch has seen one
   * yet and for a station with no ICY support at all; callers don't need
   * to tell those apart (see fetchRadioMetadata()'s own docstring).
   * Reset to null everywhere radioStation itself changes, so a stale
   * title from the *previous* station never lingers even briefly on
   * screen while the poll below catches up to the new one. */
  radioNowPlaying: string | null
  /** True only while casting radio to a Chromecast/DLNA target whose own
   * position hasn't shown real movement yet — see connect/core/
   * radio_position.py. Drives the "still buffering" state on the seek
   * bar's live-time label (SeekBar.vue/MobileTransportControls.vue)
   * instead of a frozen or misleading elapsed time. */
  radioBuffering: boolean
  initialized: boolean
}

// Pressing previous restarts the current song instead of jumping to the
// previous one once you're more than this far in — the usual behaviour for
// a music player's "previous" button. Raised from 3s (2026-08-28): a press
// this early almost always means "I meant the song before this one", and
// three seconds ran out before a reaction to a track change realistically
// lands, so the correction restarted the song it was trying to leave.
const RESTART_THRESHOLD_SECONDS = 5

// maybeAutoplay() tops the queue back up once at most this many songs are
// left after the current one — 1, not 0, so there's a whole song's worth of
// lead time for the getSimilarSongs2() round trip to finish before the
// queue would otherwise actually run dry.
const AUTOPLAY_TRIGGER_REMAINING = 1

// Edge-detects status.ended's false→true transition across SSE updates
// (module-level: the SSE subscription in init() is set up once per app
// lifetime, not per store-consumer, so this doesn't belong in state).
const endedEdge = createEdgeDetector()

// Guards adoptCastQueue()'s per-song getSong() lookups against firing again
// for every ~2s SSE tick while resolving the same incoming queue is still in
// flight — keyed by the joined id sequence being resolved, not a single song
// id, since adopting now means mirroring the whole queue, not just the
// current song.
const queueReconcileGuard = createKeyedGuard<string>()

// Guards maybeAutoplay() against firing a second, overlapping fetch —
// startCurrent() and adoptCastQueue() both call it on every song change,
// which for a cast session receiving ~2s SSE ticks can mean several calls
// landing before the first getSimilarSongs2() round trip even returns.
// Module-level, not per-invocation, for the same reason as
// queueReconcileGuard above: it needs to survive across those calls.
const autoplayLock = createLock()

// Guards switchToIndex()'s catch block against rolling currentIndex back
// once it's no longer the *latest* switch attempt. Without this, a
// slow-to-fail older call (e.g. the first of two rapid Next clicks) can
// resolve its catch after a second, successful switchToIndex() has already
// moved currentIndex on, stomping it back to the wrong song. Module-level
// for the same reason as endedEdge above — this needs to survive across
// calls, not live in per-invocation local state.
const switchToIndexGuard = createSequenceGuard()

// Guards togglePlay() against a second call landing while the connect
// branch's first one is still awaiting its pause()/resume() round trip —
// this.isPlaying isn't updated optimistically there (only the next SSE
// status tick does that, see the $subscribe callback in init()), so a
// rapid double-click/double-tap otherwise reads the same stale isPlaying
// twice and fires the *same* action again instead of alternating (observed
// live 2026-08-20 as two /pause calls 66ms apart, no /resume between).
// Worse than just "wrong direction": each call also forces a real device
// reconnect (pause()/resume() both do), and several of those piling up in
// a few seconds accumulates enough real buffering lag that the position-
// resync loop's next correction lands as one big, visible jump — read live
// as lyrics/visualizer snapping backward. Debouncing here is the actual
// fix for that: cutting the reconnect pile-up off at the source instead of
// only smoothing its aftermath (see PlaybackClock.elapsed()'s own comment
// for the latter's half of this fix).
const togglePlayLock = createLock()

// Guards startCurrent()'s own tail (the isPlaying=true flip and "now
// playing" scrobble) against applying once a newer startCurrent() has since
// superseded it — the same class of race switchToIndexGuard guards against
// above. Kept separate from switchToIndexGuard since startCurrent() also
// runs outside switchToIndex() (playSongList(), advanceOnSongEnd()'s
// repeat-one branch).
const startCurrentGuard = createSequenceGuard()

// Set while our own startCurrent() has told the connect backend to switch
// to a song but hasn't heard back yet — an SSE status tick can land in
// that gap still reporting the *previous* song (the backend hasn't
// processed our command yet), which reconcileFromStatus() would otherwise
// read as "a queue it doesn't recognize" and blow away the whole queue down
// to that one stale song. See reconcileFromStatus()'s early return below.
const localSongChangeGuard = createKeyedGuard<string>()

// The song id already registered as "played" (scrobble submission=true)
// during the current play-through — guards checkScrobbleThreshold() against
// submitting more than once per play, and naturally allows a re-scrobble
// when the same song is played again later (a fresh startCurrent() resets
// this to null first, see below).
let scrobbledSongId: string | null = null

// Smooths cast playback's position — see positionTracker.ts's own comment
// for why and how. The status tick's position is server-authoritative and
// buffering-delay-calibrated (see connect/routes/playback.py's
// _apply_position_offset) — exactly what record() below should anchor to.
const positionTracker = createPositionTracker()

// Subsonic/Last.fm convention: a play counts once listened past 50% of the
// song or 4 minutes, whichever comes first.
const SCROBBLE_PERCENT = 0.5
const SCROBBLE_MAX_SECONDS = 240

let persistTimer: ReturnType<typeof setTimeout> | null = null
// Whether the sessionStorage marker read at boot (see SESSION_WAS_PLAYING_KEY
// above) says this is a reload of a session that was already playing — set
// once by restoreFromStorage(), read once by resumeLocalPlayback().
let restoredWasPlaying = false
// Sequences with connect's first SSE status tick (or a timeout, whichever
// comes first) so local resume only ever gets decided once — see
// decideLocalResume()/attemptLocalResumeAfterAuth().
let localResumeDecided = false

// Tracks connect.isActive across SSE ticks so a live true→false transition
// (user hit "Stop casting"/disconnected the last device mid-session) can be
// told apart from merely observing "not casting" on app boot, which
// decideLocalResume() already owns — see the $subscribe handler in init().
const castingActiveEdge = createEdgeDetector()

// The last status payload whose `interrupted` flag was already acted on.
// The $subscribe handler below runs on *every* mutation of the connect
// store, not only when a new payload lands, and it re-reads the same
// `state.status` object each time — so a payload carrying interrupted=true
// raised its toast again on every unrelated mutation (device list refresh,
// volume, ...). Worse, an interruption is exactly when no newer payload is
// coming to clear it: the session is no longer streaming, so /events falls
// back to heartbeats and that payload stays the current one indefinitely.
// Observed live as the same toast reappearing every few seconds, forever.
// Comparing payload identity keeps the backend's "one-shot flag on a single
// broadcast" contract intact on this side: acted on once per payload, and a
// genuinely new interruption arrives as a new object.
let interruptedPayloadHandled: unknown = null

// All the singleton bookkeeping above (endedEdge, the seq/keyed guards,
// persistTimer, ...) lives outside Pinia's own reactive state, so Vite's
// partial HMR doesn't know to reset or preserve it consistently — a live
// edit to this file while a song's playing can leave a *new* module
// instance's fresh guard state racing against timers/subscriptions still
// running from the *old* one, which reads as impossible playback bugs (UI
// stuck on a track connect already advanced past, see the 2026-08-18
// "stuck on Tinlicker" debugging session).
// hot.decline() used to be the direct way to opt a module out of HMR, but
// Vite removed it — self-accepting and immediately invalidating is the
// current replacement, forcing a full reload on any edit to this file
// instead of a partial hot-swap. Slower, but guarantees a clean,
// single-instance start every time.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot!.invalidate(
      'stores/playback.ts holds singleton state that cannot be safely hot-reloaded',
    )
  })
}

/**
 * Casting is a built-in playback target here, not an external interception
 * layer — every action below checks `useConnectStore().isActive` itself and
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
      currentIndex: -1,
      isPlaying: false,
      castInterrupted: false,
      localPosition: 0,
      bufferedPosition: 0,
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
      radioNowPlaying: null,
      radioBuffering: false,
      initialized: false,
    }
  },

  getters: {
    currentSong(state): Song | null {
      return state.currentIndex >= 0 ? (state.queue[state.currentIndex] ?? null) : null
    },
    hasNext(state): boolean {
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
  },

  actions: {
    /** Wires the shared AudioEngine for local playback, restores the last
     * session's queue/position (see restoreFromStorage()), and subscribes
     * to connect SSE status to mirror cast playback state + auto-advance
     * the queue on song-end. Call once (App.vue). */
    init(): void {
      if (this.initialized) return
      this.initialized = true

      // Explicit, not just relying on the drawer store's own defaults —
      // these were never meant to be restored across a restart, only
      // toggled during the running session, so a fresh app start should
      // always begin with both closed.
      useDrawersStore().resetDrawers()

      this.restoreFromStorage()

      const engine = getAudioEngine()
      engine.setVolume(this.volume)
      engine.onTimeUpdate = (position) => {
        if (!this.isCasting) {
          this.localPosition = position
          this.checkScrobbleThreshold()
        }
      }
      engine.onDurationChange = (duration) => {
        if (!this.isCasting) this.duration = duration
      }
      engine.onBufferedChange = (end) => {
        if (!this.isCasting) this.bufferedPosition = end
      }
      engine.onEnded = () => {
        if (!this.isCasting) void this.advanceOnSongEnd()
      }
      engine.onError = (message) => {
        console.error('[playback]', message)
        this.isPlaying = false
      }
      // Radio only, same as radioBuffering's own cast-side source (SSE
      // status.radio_buffering, set above) — a song's own reconnect stays
      // silent on purpose (see audioEngine.ts's reconnectOnDrop() comment),
      // so this leaves radioBuffering alone whenever there's no station to
      // report it for. Without this, a dropped local radio connection kept
      // showing "Live · {elapsed}" straight through the gap — silently
      // retrying and, once reconnected, picking the elapsed counter back up
      // from the position it dropped at (see applyStartPosition()) — rather
      // than the buffering indicator a listener actually hearing the gap
      // would expect.
      engine.onReconnectStateChange = (reconnecting) => {
        if (!this.isCasting && this.radioStation) this.radioBuffering = reconnecting
      }

      // OS media keys / lock-screen / GNOME-KDE media widget — see that
      // service's own comment. Works the same whether casting or playing
      // locally (both keep currentSong/isPlaying current either way), so
      // this needs no isCasting branch of its own the way the engine
      // callbacks above do.
      initMediaSession()

      const connect = useConnectStore()
      connect.$subscribe((_mutation, state) => {
        // As soon as we know for sure whether a cast session already owns
        // playback (the first real status tick), decide whether local
        // <audio> should resume instead — see decideLocalResume().
        if (state.status) this.decideLocalResume()

        const status = state.status
        const activeNow = connect.isActive
        // A live end-of-cast transition (not "wasn't casting at boot",
        // which decideLocalResume() above already handles) — this.isPlaying
        // /this.localPosition below still hold the last real values reported
        // while casting, since this same tick's early return (right below)
        // skips overwriting them from a now-inactive status. Exactly what
        // local playback should pick back up from.
        const castingEdge = castingActiveEdge.update(activeNow)
        if (localResumeDecided && castingEdge === 'falling') {
          // A takeover displacing this session from its target is not the
          // user asking to stop — picking playback back up over local
          // speakers would be audibly wrong (nobody asked this machine to
          // start making sound). Just go quiet instead; see ConnectStatus.
          // displaced's comment and displace_target() in session.py.
          if (status?.displaced) this.isPlaying = false
          else void this.handOffToLocalPlayback()
        }

        // Once per payload, not once per mutation — see
        // interruptedPayloadHandled. Checked before the guard below, since
        // that returns early whenever targets are already gone.
        if (status?.interrupted && status !== interruptedPayloadHandled) {
          interruptedPayloadHandled = status
          this.notifyCastInterrupted()
        }

        if (!status || !activeNow) return

        this.isPlaying = status.streaming && !status.paused
        this.radioBuffering = status.radio_buffering
        if (status.current_song) this.duration = status.current_song.duration
        // Through the tracker, never straight from status.elapsed: the
        // smoothing interval below reads that same tracker, so writing the
        // raw value here as well put two disagreeing numbers on screen in
        // turn — the raw one for the ~200ms until the next interval tick,
        // the smoothed one for the rest of the ~2s until the next status
        // tick. As long as the two agreed to within a second that stayed
        // invisible behind formatTime()'s rounding; once the tracker was
        // carrying any real lead (see positionTracker.ts's CATCH_UP_SECONDS)
        // it read as the counter jumping a second or two backwards and
        // forwards, twice per status tick, with the lyrics highlight
        // following it. Ordered after the duration above so a tick that
        // brings a new song's length clamps against that one, not the
        // previous song's.
        const now = performance.now()
        positionTracker.record(status.elapsed, now)
        this.localPosition = positionTracker.extrapolate(now, this.duration)
        this.checkScrobbleThreshold()

        void this.reconcileFromStatus(status)

        if (endedEdge.update(status.ended) === 'rising') void this.advanceOnSongEnd()
      })

      // Smooths the ~2s-stepped position above into something that moves
      // every 200ms instead — see positionTracker.ts's own comment. A no-op
      // whenever not actively cast-playing, so this is cheap to just leave
      // running for the app's whole lifetime rather than starting/stopping
      // it around every play/pause/cast-toggle.
      setInterval(() => {
        if (!this.isCasting || !this.isPlaying || !positionTracker.hasAnchor()) return
        this.localPosition = positionTracker.extrapolate(performance.now(), this.duration)
      }, 200)

      // Polls this session's ICY "now playing" tag (services/connect/
      // radioMetadata.ts) for whichever station is current - pushed from
      // the connect backend's own background watch, not derived locally,
      // since a plain HTML5 <audio> element never sees it at all itself.
      // A no-op whenever no radio is playing, same as the position-
      // smoothing interval above, so this is cheap to just leave running
      // for the app's whole lifetime rather than starting/stopping it
      // around every radio play/stop.
      const pollRadioMetadata = () => {
        const station = this.radioStation
        if (!station) return
        fetchRadioMetadata()
          .then((title) => {
            // The station may have changed while this was in flight - a
            // stale answer for the *previous* one must never overwrite
            // this one's (already-reset-to-null) title.
            if (this.radioStation?.streamUrl === station.streamUrl) this.radioNowPlaying = title
          })
          .catch(() => {})
      }
      setInterval(() => {
        // Skipped while the window is hidden or the app is being denied by
        // whatever sits in front of the backend (see pollGate.ts). Nothing
        // renders this title but SongInfo.vue, so a hidden window was
        // asking for it several hundred times an hour for nobody.
        if (pollingAllowed()) pollRadioMetadata()
      }, 8000)
      // ...which would leave a stale title on screen for up to one interval
      // on the way back, so the return is what refreshes it rather than the
      // next tick after it.
      document.addEventListener('visibilitychange', () => {
        if (pollingAllowed()) pollRadioMetadata()
      })

      // Keeps the persisted snapshot fresh so a reload always has something
      // recent to resume from. Debounced — this fires on every playback
      // mutation, including the ~4x/sec local position tick, so writing on
      // every single one would spam localStorage for no benefit.
      // detached: true — this must outlive whatever component happened to
      // call init() (App.vue never unmounts in practice, but this shouldn't
      // depend on that).
      this.$subscribe(
        () => {
          if (persistTimer) return
          persistTimer = setTimeout(() => {
            persistTimer = null
            this.persistNow()
          }, 1000)
        },
        { detached: true },
      )
    },

    /** Reads the last session's queue/position snapshot from localStorage
     * (if any) into state — called once from init(), before anything else,
     * so it's already in place by the time either resumeLocalPlayback() or
     * a connect SSE reconcile needs it (see both). Does not itself start
     * any playback. Also captures the sessionStorage reload marker (see
     * SESSION_WAS_PLAYING_KEY's own comment) into restoredWasPlaying, ahead
     * of anything in this fresh instance that could overwrite it — read
     * unconditionally, before the early return below, since it's an
     * independent signal from whether a localStorage snapshot exists at
     * all. */
    restoreFromStorage(): void {
      restoredWasPlaying = readSessionWasPlaying()
      const saved = loadPersisted()
      if (!saved) return
      this.queue = saved.queue
      this.originalQueue = saved.originalQueue
      this.currentIndex = saved.currentIndex
      this.radioStation = saved.radioStation
      this.shuffle = saved.shuffle
      this.repeatMode = saved.repeatMode
      this.volume = saved.volume
      // Falls back to 'off' for data saved before this field existed.
      this.replayGainMode = saved.replayGainMode ?? 'off'
      this.localPosition = saved.localPosition
    },

    persistNow(): void {
      savePersisted({
        queue: this.queue,
        originalQueue: this.originalQueue,
        currentIndex: this.currentIndex,
        radioStation: this.radioStation,
        shuffle: this.shuffle,
        repeatMode: this.repeatMode,
        volume: this.volume,
        replayGainMode: this.replayGainMode,
        localPosition: this.localPosition,
      })
      // Not just this.isPlaying — resumeLocalPlayback() (the only reader of
      // this) needs to know whether *local* playback specifically was
      // audible, and this.isPlaying is true while casting too, when nothing
      // was actually coming out of this device's own speakers. See
      // SESSION_WAS_PLAYING_KEY's own comment for why this lives in
      // sessionStorage rather than alongside the snapshot above.
      writeSessionWasPlaying(this.isPlaying && !this.isCasting)
    },

    /** Called from authStore.restore() once a silent re-auth on app boot
     * succeeds — deliberately not from App.vue's generic `authenticated`
     * watcher, since that also fires after a genuine fresh login, where
     * auto-resuming whatever was persisted from a previous session would be
     * surprising rather than helpful. Starts a short fallback timer for
     * decideLocalResume() in case the connect backend never answers at all
     * (unreachable, or this build has no casting support), so a restored
     * queue doesn't just sit there forever waiting to learn whether a cast
     * session already owns playback. The normal case (the backend does
     * answer) is handled by init()'s own connect subscription calling
     * decideLocalResume() as soon as the first status tick arrives —
     * whichever of the two happens first wins, decideLocalResume() is
     * idempotent either way. */
    attemptLocalResumeAfterAuth(): void {
      setTimeout(() => this.decideLocalResume(), 2000)
    },

    decideLocalResume(): void {
      if (localResumeDecided) return
      localResumeDecided = true
      if (!useConnectStore().isActive) void this.resumeLocalPlayback()
    },

    /** Resumes (or pre-loads) local <audio> playback from the snapshot
     * restoreFromStorage() put into state — only called once we know a cast
     * session isn't already handling it (see decideLocalResume()). Whether
     * it actually starts sound turns on restoredWasPlaying (the
     * sessionStorage marker read once in restoreFromStorage() — see
     * SESSION_WAS_PLAYING_KEY's own comment): true only for a reload of a
     * session that was already playing, never for a genuine app restart —
     * that's the app's own decision to make sound happen again, not the
     * user's, on a boot the user didn't just press play to trigger. A
     * restart still gets the song/position loaded either way, so pressing
     * play afterwards has something to resume instead of an empty element.
     * Radio has nothing stable to preload when it wasn't playing (no
     * position to seek a live stream to), so a restart leaves it untouched
     * beyond the station name already restored into state. */
    async resumeLocalPlayback(): Promise<void> {
      if (this.radioStation) {
        if (restoredWasPlaying) {
          getAudioEngine().play(this.radioStation.streamUrl)
          this.isPlaying = true
          startRadioMetadataWatch(this.radioStation.streamUrl)
        }
        return
      }
      const song = this.currentSong
      if (!song) return
      const url = this.localStreamUrl(song)
      const gain = this.replayGainMultiplier
      if (restoredWasPlaying) {
        getAudioEngine().play(url, this.localPosition, gain)
        this.isPlaying = true
      } else {
        getAudioEngine().load(url, this.localPosition, gain)
      }
    },

    /** The live-session counterpart to resumeLocalPlayback() — called when
     * a cast session ends mid-session (see init()'s connect $subscribe
     * handler) instead of at app boot. The local <audio> element is never
     * kept in sync while casting (every song start/advance goes to the
     * connect backend instead — see startCurrent()/switchToIndex()), so
     * without this it's left pointing at stale or empty state once casting
     * stops, and play/pause afterwards does nothing or plays the wrong
     * song. Picks up from this.isPlaying/this.localPosition (this
     * session's own live values) rather than resumeLocalPlayback()'s
     * restored-from-storage snapshot. */
    async handOffToLocalPlayback(): Promise<void> {
      // Casting is over; there is nothing left to resume on a device.
      this.castInterrupted = false
      if (this.radioStation) {
        // Casting is what radioBuffering describes (a cast target still
        // filling its own startup buffer — see SeekBar.vue's own comment);
        // local playback has no equivalent stall to report, and the SSE
        // handler that normally clears this on the way down (playback.ts's
        // own $subscribe) has already stopped running by the time this
        // runs (`!activeNow` short-circuits it first). Left stale, the
        // "Buffering…" indicator it drives would otherwise stick forever
        // once audio has clearly already started.
        this.radioBuffering = false
        if (this.isPlaying) {
          getAudioEngine().play(this.radioStation.streamUrl)
          startRadioMetadataWatch(this.radioStation.streamUrl)
        }
        return
      }
      const song = this.currentSong
      if (!song) return
      const url = this.localStreamUrl(song)
      const gain = this.replayGainMultiplier
      if (this.isPlaying) {
        getAudioEngine().play(url, this.localPosition, gain)
      } else {
        getAudioEngine().load(url, this.localPosition, gain)
      }
    },

    /** Keeps this.queue/currentIndex mirroring the connect backend's
     * reported queue/current_song_index whenever they're out of sync with
     * local state — connect auto-advancing on its own (see AppState.queue's
     * comment) is one cause, another *client* sharing this session editing
     * the queue (reorder/add/remove/skip — see syncCastQueue()) is another.
     * Delegates to adoptCastQueue() for the actual rebuild; this just
     * filters out the cases that don't apply (radio has no queue, our own
     * dispatch hasn't been confirmed yet). A no-op once local state already
     * matches. */
    async reconcileFromStatus(status: ConnectStatus): Promise<void> {
      if (status.radio) {
        if (this.radioStation?.streamUrl !== status.radio.url) {
          this.originalQueue = []
          this.queue = []
          this.currentIndex = -1
          this.radioStation = await resolveRadioStation(
            status.radio.url,
            status.radio.title,
            this.radioStation,
          )
          this.radioNowPlaying = null
          // Same reset playRadioStation() does, and for the identical
          // reason (see its own comment): another client switching this
          // shared session to radio takes this branch instead of that one,
          // and without it this client's stale track duration keeps
          // clamping positionTracker.extrapolate()'s live elapsed between
          // SSE ticks — the same stuck-duration bug, just reached from the
          // remote-initiated path.
          this.duration = 0
          positionTracker.reset()
        }
        return
      }

      if (!status.current_song) return
      if (localSongChangeGuard.hasAny()) return // our own song switch hasn't been confirmed yet — see above

      await this.adoptCastQueue(status)
    },

    /** Rebuilds this.queue/originalQueue/currentIndex and adopts shuffle/
     * repeatMode from connect's authoritative state (status.queue/
     * original_queue/current_song_index/shuffle/repeat_mode — see
     * AppState's comments) — the counterpart to syncCastQueue() pushing
     * local edits *out*. Together these keep every client sharing a cast
     * session showing the same queue/now-playing/toggle-state, not just
     * whichever one made the last dispatch. Without this, a
     * reorder/add/remove/skip/shuffle-toggle on *another* client stayed
     * invisible here until this client happened to already have the
     * resulting current_song somewhere in its own, unrelated queue. */
    async adoptCastQueue(status: ConnectStatus): Promise<void> {
      const remoteQueueIds = status.queue
      if (remoteQueueIds.length === 0) return // nothing dispatched on the backend side yet

      // Plain flags, no resolution needed — adopt independently of (and
      // before) the possibly-async queue rebuild below, so a flag-only
      // change from another client (e.g. toggling repeat mode without
      // touching the queue) doesn't wait on anything.
      if (this.shuffle !== status.shuffle) this.shuffle = status.shuffle
      if (this.repeatMode !== status.repeat_mode) this.repeatMode = status.repeat_mode
      // Same treatment, and for a sharper reason: the backend tops the
      // queue up on its own from this flag (see routes/stream.py's
      // _maybe_autoplay_topup), so a client left showing its own stored
      // value reads "off" while songs keep appearing — reported live
      // 2026-08-28 from a phone that had never sent a /play of its own and
      // so had never corrected the session's value either.
      const autoplay = useAutoplayStore()
      if (autoplay.enabled !== status.autoplay_enabled) {
        autoplay.setEnabled(status.autoplay_enabled)
      }

      const remoteOriginalIds = status.original_queue
      // See diffCastQueue()'s own comment for why an empty remote
      // original_queue counts as a match rather than something to adopt.
      const { queueMatches, originalMatches } = diffCastQueue(
        { queue: this.queue.map((t) => t.id), originalQueue: this.originalQueue.map((t) => t.id) },
        { queue: remoteQueueIds, originalQueue: remoteOriginalIds },
      )

      if (queueMatches && originalMatches) {
        // Contents already match — currentIndex can still be stale on its
        // own (e.g. a fresh SSE subscription discovering playback already
        // in progress), so that's not folded into the comparison above.
        this.currentIndex = status.current_song_index
        void this.maybeAutoplay()
        return
      }

      const key = `${remoteQueueIds.join(',')}|${remoteOriginalIds.join(',')}`
      if (queueReconcileGuard.isCurrent(key)) return // already resolving this exact pair

      queueReconcileGuard.begin(key)
      try {
        const library = useLibraryStore()
        // Reuses this client's own existing Song object for any id it
        // already has (from either list) — QueueDrawer.vue/
        // MobileQueueView.vue key their rows off the object, not just the
        // id (see dedupeForQueue()'s comment), so handing them a brand-new
        // object for a song that didn't actually move would needlessly
        // break row identity/animations.
        const existingById = new Map([...this.queue, ...this.originalQueue].map((t) => [t.id, t]))
        const neededIds = [...new Set([...remoteQueueIds, ...remoteOriginalIds])]
        const resolvedById = new Map<string, Song>()
        await Promise.all(
          neededIds.map(async (id) => {
            const cached = existingById.get(id) ?? library.allSongs.find((t) => t.id === id)
            if (cached) {
              resolvedById.set(id, cached)
              return
            }
            try {
              resolvedById.set(id, await library.client().getSong(id))
            } catch (error) {
              console.error('[playback] Failed to resolve synced queue song:', id, error)
            }
          }),
        )
        // Re-check after the awaits — a local action (or a newer status
        // tick resolving first) may have already moved state on.
        if (!queueReconcileGuard.isCurrent(key)) return
        // A lookup failed for something either list needs — leave local
        // state as-is rather than adopting a queue with a hole in it; the
        // next status tick tries again.
        if (neededIds.some((id) => !resolvedById.has(id))) return
        if (this.radioStation) {
          stopRadioMetadataWatch()
          this.radioNowPlaying = null
        }
        this.radioStation = null
        if (!queueMatches) this.queue = remoteQueueIds.map((id) => resolvedById.get(id)!)
        if (!originalMatches)
          this.originalQueue = remoteOriginalIds.map((id) => resolvedById.get(id)!)
        this.currentIndex = status.current_song_index
        void this.maybeAutoplay()
      } finally {
        queueReconcileGuard.end(key)
      }
    },

    /** Sets up queue + currentIndex only — no playback side effect.
     *
     * `pinFirst`: whether `songs[startIndex]` was something the user
     * actually picked (a specific row clicked in a list) as opposed to just
     * where a generic "Play"/"Play random" action happens to start counting
     * from (always 0, no real selection behind it). True keeps that song
     * first even under shuffle — "you picked this one, shuffle only decides
     * what comes after" (also what Song/Artist Radio wants, see
     * startSongRadio()). False lets shuffle include the very first song
     * too — without this, hitting "Play" on a shuffled playlist/album
     * always started on track 1 in its original, unshuffled position,
     * shuffle only kicking in from the second song onward. */
    setQueue(songs: Song[], startIndex = 0, pinFirst = true): void {
      if (this.radioStation) {
        stopRadioMetadataWatch()
        this.radioNowPlaying = null
      }
      this.radioStation = null
      this.originalQueue = [...songs]
      // Unshuffled, this.queue is `songs` in the same order, so startIndex
      // already *is* the right index — re-deriving it by id below would
      // resolve to the first occurrence of that id instead, playing the
      // wrong position whenever the same song appears twice in the list
      // (e.g. a playlist with a duplicate, or two concatenated playlists).
      // Shuffled, shuffledExcept() always places the kept song at index 0,
      // so the id lookup there can only ever match that same instance.
      if (this.shuffle) {
        const keep = pinFirst ? songs[startIndex] : null
        this.queue = shuffledExcept(songs, keep)
        this.currentIndex = keep ? this.queue.findIndex((t) => t.id === keep.id) : 0
      } else {
        this.queue = [...songs]
        this.currentIndex = startIndex
      }
    },

    /** Index math only (repeat-mode aware), no state mutation — returns the
     * index playNext()/playPrevious() should switch to, or null if there's
     * nowhere to go. Deliberately doesn't touch currentIndex itself: it used
     * to, but that let the UI (queue highlight, PlayerBar) jump to the next
     * song before the connect dispatch that's supposed to actually start it
     * had even resolved. If that dispatch then failed (device briefly
     * unreachable, claim race, ...), nothing rolled the index back — Beacon
     * kept showing "now playing" whatever song it had optimistically
     * advanced to, while the connect target was still audibly on the
     * previous one. See switchToIndex(), which now owns committing the
     * index change only once startCurrent() actually succeeds. */
    nextIndex(delta: 1 | -1): number | null {
      if (delta === 1) {
        if (this.currentIndex < this.queue.length - 1) return this.currentIndex + 1
        if (this.repeatMode === 'all' && this.queue.length > 0) return 0
        return null
      }
      if (this.currentIndex > 0) return this.currentIndex - 1
      if (this.repeatMode === 'all' && this.queue.length > 0) return this.queue.length - 1
      return null
    },

    /** Switches to `index` and starts it — rolls currentIndex back to
     * whatever it was before if the dispatch fails, so a transient error
     * (cast target briefly unreachable, claim conflict, ...) can't leave the
     * UI pointing at a song that never actually started playing.
     *
     * `preservePause`: startCurrent() (both its local <audio> and connect
     * branches) always starts playback immediately — neither side has a
     * "load paused" option — so without this, navigating while paused would
     * silently resume playback the user deliberately paused. playNext()/
     * playPrevious() (the transport buttons, a "what's loaded" change) pass
     * true; playAtIndex() (explicitly picking a song from the queue, closer
     * to "play this now") deliberately leaves it false, same as before. */
    async switchToIndex(index: number, preservePause = false): Promise<void> {
      const previous = this.currentIndex
      const wasPlaying = this.isPlaying
      this.currentIndex = index
      const seq = switchToIndexGuard.begin()
      try {
        const applied = await this.startCurrent()
        if (!applied) {
          // Superseded by a newer dispatch — this device's own later call,
          // or another client sharing this connect session (see
          // startCurrent()'s docstring). Nothing actually started here, so
          // undo the optimistic currentIndex bump above the same way the
          // catch block below does for a genuine failure — whichever
          // dispatch really won updates currentIndex correctly on its own
          // next real SSE status tick (see reconcileFromStatus()).
          if (switchToIndexGuard.isCurrent(seq)) this.currentIndex = previous
          return
        }
        // Only re-pause if nothing newer has taken over in the meantime —
        // same staleness guard as the catch block below, see
        // switchToIndexGuard's comment.
        if (preservePause && !wasPlaying && switchToIndexGuard.isCurrent(seq)) {
          if (this.isCasting) await connectPlayback.pause()
          else getAudioEngine().pause()
          this.isPlaying = false
        }
      } catch (error) {
        // Only roll back if nothing newer (another switchToIndex call) has
        // already taken over — otherwise this stale failure would stomp
        // currentIndex back over a since-successful switch. See
        // switchToIndexGuard's comment.
        if (switchToIndexGuard.isCurrent(seq)) {
          this.currentIndex = previous
          this.isPlaying = false
        }
        console.error('[playback] Failed to switch songs:', error)
      }
    },

    /** `peek` opens the queue drawer on the new queue — every caller that
     * replaces the queue passes it, except one handing a single song that
     * plays immediately (see peekQueueDrawer()'s own comment for the exact
     * rule). It has to happen here rather than in the caller, right after
     * the mutation and
     * *before* the await: the reveal animation is driven by per-row
     * transition delays that only exist once peekQueueDrawer() has marked
     * which songs are new, so marking them a caller's `await` too late
     * means Vue has already rendered — and fully animated — those rows on
     * the mutation alone, un-staggered and, if the drawer was shut,
     * entirely out of sight. Reported live 2026-08-26 as Song Radio
     * animating the queue in the first time and never again (the first
     * time only worked because DefaultLayout.vue hadn't mounted the drawer
     * yet, making it an initial render its `appear` covers). */
    async playSongList(
      songs: Song[],
      startIndex = 0,
      pinFirst = true,
      peek = false,
    ): Promise<void> {
      this.setQueue(songs, startIndex, pinFirst)
      if (peek) useDrawersStore().peekQueueDrawer(this.queue)
      await this.startCurrent()
    },

    /** Song Radio — fetches songs similar to `song` from the media server
     * and starts a fresh queue with `song` first, so picking it always
     * plays the song you actually clicked, not an arbitrary similar one. */
    async startSongRadio(song: Song): Promise<void> {
      const { songs: similar, plexPassRequired } = await useLibraryStore()
        .client()
        .getSimilarSongs2(song.id)
      if (plexPassRequired) notifyPlexPassRequired('library.songRadio')
      const songs = [song, ...similar.filter((t) => t.id !== song.id)]
      // peek: a server-picked mix, unlike playSongList()'s other, more
      // direct callers (clicking a song/album/playlist you were already
      // looking at) — see peekQueueDrawer()'s own comment for why that
      // distinction is what actually decides whether a call site peeks.
      await this.playSongList(songs, 0, true, true)
    },

    /** Artist Radio — same getSimilarSongs2 endpoint as Song Radio, but
     * `id` here is the artist's own id rather than a song's; Navidrome's
     * recommendation engine accepts either (see SubsonicClient.
     * getSimilarSongs2's docstring). No single "seed" song to pin first
     * like Song Radio does — the whole point here is a mix across the
     * artist's catalog, not one particular song. */
    async startArtistRadio(artist: Artist): Promise<void> {
      const { songs, plexPassRequired } = await useLibraryStore()
        .client()
        .getSimilarSongs2(artist.id)
      if (plexPassRequired) notifyPlexPassRequired('library.artistRadio')
      // peek — see startSongRadio()'s identical comment.
      await this.playSongList(songs, 0, true, true)
    },

    async playRadioStation(station: RadioStation): Promise<void> {
      const connect = useConnectStore()
      // A station published as a .m3u/.pls names where its audio really is
      // rather than being it (see services/connect/radio.ts) — resolved
      // once, here, and used for everything below. Deliberately not left to
      // the backend alone even though /play-url resolves it too: the
      // station this store holds has to carry the same URL connect ends up
      // reporting in its status, or reconcileFromStatus() reads every
      // single tick as a station change and rebuilds the station over and
      // over. Costs a round trip only for a URL that actually looks like a
      // playlist.
      const streamUrl = await resolveRadioStreamUrl(station.streamUrl)
      this.originalQueue = []
      this.queue = []
      this.currentIndex = -1
      this.radioStation = { ...station, streamUrl }
      this.radioNowPlaying = null
      // Cleared here rather than left to the first SSE tick — that first
      // tick is itself delayed by however long /play-url's own dispatch
      // takes, and a stale true/false from whatever this session was doing
      // a moment ago (a different station, a track) would otherwise show
      // for that whole gap.
      this.radioBuffering = false
      this.localPosition = 0
      // Radio has no track duration — status.current_song is always null
      // for it, so nothing else ever clears whatever this held from the
      // last track played, and positionTracker.extrapolate() (see its own
      // comment) then clamps every 200ms tick to that stale number instead
      // of leaving live elapsed unclamped. Reported live 2026-09-02 as the
      // seek bar's "Live · {time}" label sticking on the last track's
      // duration, only flickering to the real value on each ~2s SSE tick
      // (positionTracker.extrapolate() runs unclamped in between those,
      // right up until the next tick re-clamps it).
      this.duration = 0
      // Same reasoning as startCurrent()'s identical reset() call — without
      // it, extrapolation would keep advancing from the last track's final
      // anchor until the first real radio status tick corrects it.
      positionTracker.reset()
      // Local playback never otherwise touches the connect backend at all
      // (see services/connect/radioMetadata.ts's own docstring) - the
      // casting branch below also starts one on its own via /play-url, so
      // this call is a harmless, idempotent repeat there rather than a
      // second, redundant watch.
      startRadioMetadataWatch(streamUrl)

      if (connect.isActive) {
        await connectPlayback.playUrl(streamUrl, station.name, {
          targets: connect.activeTargets,
          castDirectly: useRadioSettingsStore().castDirectly,
        })
      } else {
        getAudioEngine().play(streamUrl)
      }
      this.isPlaying = true
    },

    /** Returns false without applying isPlaying/scrobble if connect dropped
     * this dispatch as superseded by a newer one — this connect session can
     * be controlled live by more than one client at once (this device and,
     * say, a phone on the same account/server — see connectPlayback.play()'s
     * dispatchSeq comment and PlayResponse.status's own docstring), and the
     * backend's play_seq is what keeps "the last real dispatch wins" true
     * even when two clients race. Without checking this, a superseded
     * client would confidently claim its own (never-applied) song/isPlaying
     * as current regardless of what actually ended up playing — exactly the
     * "UI shows one song, a different one is audibly playing" desync a
     * multi-client session should never produce. True otherwise (including
     * always for local, non-cast playback, which has no such race). */
    async startCurrent(startPosition = 0): Promise<boolean> {
      const song = this.currentSong
      if (!song) return false
      const seq = startCurrentGuard.begin()
      const connect = useConnectStore()
      this.localPosition = startPosition
      scrobbledSongId = null // fresh play-through, even if it's the same song id as before
      // Otherwise the extrapolation interval (see positionTracker.ts's own
      // comment) would keep advancing *this* song's position from the
      // *previous* song's last known elapsed until the next real SSE tick
      // corrects it — a stale number that looks like live progress, worse
      // than just sitting still. Cleared here regardless of cast state;
      // harmless when not casting since the interval already no-ops then.
      positionTracker.reset()

      if (connect.isActive) {
        localSongChangeGuard.begin(song.id)
        let response: PlayResponse
        const {
          fullQueue,
          queueIndex,
          originalQueue,
          shuffle,
          repeatMode,
          autoplayEnabled,
          autoplayBatchSize,
        } = this.castQueuePayload
        try {
          response = await connectPlayback.play(song.id, {
            targets: connect.activeTargets,
            startPosition,
            gain: this.replayGainMultiplier,
            ...this.castQualityPayload,
            fullQueue,
            queueIndex,
            originalQueue,
            shuffle,
            repeatMode,
            autoplayEnabled,
            autoplayBatchSize,
          })
        } finally {
          localSongChangeGuard.end(song.id)
        }
        if (response.status === 'superseded') return false
      } else {
        const url = this.localStreamUrl(song)
        getAudioEngine().play(url, startPosition, this.replayGainMultiplier)
      }
      // A newer startCurrent() already took over while the above awaited —
      // applying isPlaying/scrobble here would be reporting "now playing"
      // for a song that isn't the current one anymore. See
      // startCurrentGuard's comment.
      if (!startCurrentGuard.isCurrent(seq)) return false
      this.isPlaying = true
      void useLibraryStore()
        .client()
        .scrobble(song.id, false)
        .catch((error) => console.error('[scrobble] now-playing failed:', error))
      void this.maybeAutoplay()
      return true
    },

    /** Registers the current song as "played" with the media server once
     * enough of it has actually been listened to — this is what drives
     * Navidrome's "recently played"/"frequent" album shelves and song play
     * counts. Called on every position update (local and cast), cheap no-op
     * once already submitted for this play-through (see scrobbledSongId). */
    checkScrobbleThreshold(): void {
      const song = this.currentSong
      if (!song || this.radioStation || scrobbledSongId === song.id) return
      const duration = this.duration || song.duration
      if (!duration) return
      const threshold = Math.min(duration * SCROBBLE_PERCENT, SCROBBLE_MAX_SECONDS)
      if (this.localPosition < threshold) return
      scrobbledSongId = song.id
      void useLibraryStore()
        .client()
        .scrobble(song.id, true)
        .then(() => {
          // Optimistic, not re-fetched from the server — the count shown
          // anywhere this same Song object is rendered (queue, song
          // lists, Stats) would otherwise stay stale until something else
          // happened to reload it, even though the scrobble itself
          // genuinely succeeded server-side.
          song.playCount = (song.playCount ?? 0) + 1
        })
        .catch((error) => console.error('[scrobble] submission failed:', error))
    },

    async togglePlay(): Promise<void> {
      // See togglePlayLock's own comment — a second call landing while
      // the connect branch's first one is still in flight would otherwise
      // read the same stale this.isPlaying and re-fire the same action.
      if (togglePlayLock.isLocked()) return
      togglePlayLock.acquire()
      try {
        const connect = useConnectStore()
        if (connect.isActive) {
          if (this.isPlaying) {
            await connectPlayback.pause()
          } else if (connect.status?.ended) {
            // Mirrors the local <audio> engine's hasEnded branch below — a
            // connect session whose stream already ran to completion (last
            // song of a non-repeating queue) doesn't actually restart from a
            // bare resume() any more than an ended <audio> element does, just
            // on the backend's media pipeline instead of the browser's: the
            // reported position stays frozen wherever it ended, no audio
            // reaches the cast target, and the visualizer feed (GET
            // /visualizer) and lyrics sync — both driven by that position
            // actually advancing — never get anything to work from either. A
            // full restart, same as the local branch, is what actually gets
            // it playing again.
            await this.startCurrent()
          } else {
            await connectPlayback.resume()
          }
          return
        }
        const engine = getAudioEngine()
        if (this.isPlaying) {
          engine.pause()
          this.isPlaying = false
        } else if (engine.hasEnded) {
          // The loaded track already played through to the end (e.g. the last
          // song of a non-repeating queue) — a bare resume() on an ended
          // <audio> element doesn't reliably restart it, so do a proper
          // restart instead, same as switchToIndex()/startCurrent() elsewhere.
          await this.startCurrent()
        } else if (this.radioStation) {
          // resumeLocalPlayback() deliberately never loads radio into the
          // engine after a plain app restart (not restoredWasPlaying) — see
          // its own comment: there's no position to preload a live stream
          // to. engine.resume() below assumes something was already
          // loaded, which a track always is (resumeLocalPlayback() calls
          // load() unconditionally for one) but radio in that case is not
          // — resume() on an <audio> element with no src at all silently
          // did nothing. Radio has no "resume from where it paused" to
          // preserve either way, so restarting the live connection is the
          // same action whether something was loaded or not.
          getAudioEngine().play(this.radioStation.streamUrl)
          this.isPlaying = true
        } else {
          engine.resume()
          this.isPlaying = true
        }
      } finally {
        togglePlayLock.release()
      }
    },

    /** Manual "skip forward" (PlayerBar's Next button) — always advances to
     * the next song, even with repeat-one active. Repeat-one only replays
     * the current song when it ends naturally, see advanceOnSongEnd();
     * a manual skip is an explicit "I'm done with this one", same as every
     * other player. */
    async playNext(): Promise<void> {
      if (this.radioStation) return // radio has no queue to advance
      const index = this.nextIndex(1)
      if (index === null) {
        this.isPlaying = false
        return
      }
      // preservePause: harmless from advanceOnSongEnd()'s natural-end call
      // (wasPlaying is true right up to 'ended' firing, so this never
      // triggers there) — matters for the PlayerBar's own Next button, see
      // switchToIndex()'s comment.
      await this.switchToIndex(index, true)
    },

    /** Called when a song finishes on its own (local <audio> 'ended', or
     * the connect backend's status.ended transition) — unlike playNext(),
     * this is where repeat-one actually applies (replays the current song
     * instead of advancing). */
    async advanceOnSongEnd(): Promise<void> {
      if (this.radioStation) return
      if (this.repeatMode === 'one') {
        try {
          await this.startCurrent()
        } catch (error) {
          this.isPlaying = false
          console.error('[playback] Failed to replay song:', error)
        }
        return
      }
      await this.playNext()
    },

    async playPrevious(): Promise<void> {
      if (this.radioStation) return
      if (this.localPosition > RESTART_THRESHOLD_SECONDS) {
        await this.switchToIndex(this.currentIndex, true)
        return
      }
      // nextIndex(-1) returning null means "no previous" (start of a
      // non-repeating queue) — restart the current song instead, same as
      // hitting previous within RESTART_THRESHOLD_SECONDS above.
      await this.switchToIndex(this.nextIndex(-1) ?? this.currentIndex, true)
    },

    async playAtIndex(index: number): Promise<void> {
      if (index < 0 || index >= this.queue.length) return
      await this.switchToIndex(index)
    },

    async seek(position: number): Promise<void> {
      const connect = useConnectStore()
      if (connect.isActive) {
        await connectPlayback.seek(position)
        // Re-anchors the extrapolation interval (see positionTracker.ts's
        // own comment) to the seeked-to position right away — otherwise
        // it'd keep extrapolating from the pre-seek anchor for up to ~200ms
        // and briefly overwrite this seek with a stale position.
        positionTracker.record(position, performance.now())
      } else {
        getAudioEngine().seek(position)
      }
      this.localPosition = position
    },

    setVolume(volume: number): void {
      this.volume = volume
      getAudioEngine().setVolume(volume)
    },

    /** The Autoplay toggle. While casting this is a setting of the session
     * rather than of this device (see adoptCastQueue(), which adopts it
     * from the status the same way it does shuffle/repeat), so switching it
     * has to reach connect right away instead of riding along with whatever
     * queue update happens to come next — until it does, the backend keeps
     * topping the queue up from the old value. A no-op beyond the local
     * store when not casting, since syncCastQueue() returns early then. */
    setAutoplayEnabled(value: boolean): void {
      useAutoplayStore().setEnabled(value)
      this.syncCastQueue()
    },

    /** Settings-driven — applies immediately to local playback (a live Web
     * Audio GainNode, see AudioEngine.setReplayGain()), so switching modes
     * doesn't need a skip to take effect there. Casting can't be updated
     * live the same way — connect/playback.ts's `gain` is baked into
     * ffmpeg's `volume` filter argument when the stream starts (see
     * core/streamer.py), not a value the running stream can be told to
     * change — so a mode switch while casting only takes effect from the
     * next song start onward, same as any other cast-side setting would. */
    setReplayGainMode(mode: ReplayGainMode): void {
      this.replayGainMode = mode
      if (!this.isCasting) getAudioEngine().setReplayGain(this.replayGainMultiplier)
    },

    /** The stream URL for `song`, recording what was actually decided.
     * The two belong together: the stream-info panel describes what is
     * playing by reading `activeLocalStream`, and a URL built anywhere
     * else would leave that describing the previous track.
     *
     * Note this is not simply the setting — plan() applies it as a
     * ceiling, so a track already below it is fetched untouched. */
    localStreamUrl(song: Song): string {
      const streamPlan = plan(song, this.localQuality)
      this.activeLocalStream = streamPlan
      return useLibraryStore().client().streamUrl(song.id, streamPlan.quality)
    },

    /** Settings-driven. Takes effect from the next song start onward rather
     * than immediately: the running `<audio>` element is already fetching a
     * URL that encodes the old choice, and reloading it mid-track to apply
     * a quality change would cost an audible gap for no benefit. Same
     * timing as setReplayGainMode() has while casting, and for the same
     * kind of reason. */
    setLocalQuality(format: StreamFormat, bitrate?: number): void {
      this.localQuality = {
        format,
        bitrate: bitrate ?? bitrateFor(format, this.localQuality.bitrate),
      }
      this.persistQuality()
    },

    /** The ceiling for casting. Reaches connect with the next /play (see
     * castQualityPayload), which is also when auto-advance picks it up for
     * the rest of the queue — the local one is applied client-side
     * instead, see localStreamUrl(). */
    setCastQuality(format: StreamFormat, bitrate?: number): void {
      this.castQuality = {
        format,
        bitrate: bitrate ?? bitrateFor(format, this.castQuality.bitrate),
      }
      this.persistQuality()
    },

    persistQuality(): void {
      saveStreamQuality({ local: this.localQuality, cast: this.castQuality })
    },

    toggleShuffle(): void {
      this.shuffle = !this.shuffle
      const current = this.currentSong
      this.queue = this.shuffle
        ? shuffledExcept(this.originalQueue, current)
        : [...this.originalQueue]
      if (current) {
        this.currentIndex = this.queue.findIndex((t) => t.id === current.id)
      }
      this.syncCastQueue()
    },

    cycleRepeatMode(): void {
      const order: RepeatMode[] = ['off', 'all', 'one']
      this.repeatMode = order[(order.indexOf(this.repeatMode) + 1) % order.length]!
      // castQueuePayload truncates to history+current under repeat-one (see
      // its own comment) — switching into or out of that mode changes what
      // connect should be auto-advancing through even though this.queue
      // itself didn't change.
      this.syncCastQueue()
    },

    // The one central "something just landed in the queue that the user
    // didn't necessarily see coming" spot — covers every caller (a song's
    // own context menu, the mobile action sheet, remote-control commands
    // from a phone, and maybeAutoplay()'s own top-up below) with a single
    // peekQueueDrawer() rather than needing one at each call site.
    addToQueue(songs: Song[]): void {
      const toAdd = dedupeForQueue(songs, this.queue)
      this.originalQueue.push(...toAdd)
      this.queue.push(...toAdd)
      this.syncCastQueue()
      useDrawersStore().peekQueueDrawer(toAdd)
    },

    /** Autoplay — called after every song change (startCurrent(),
     * adoptCastQueue()) to top the queue back up with similar songs once
     * it's about to run out, the same getSimilarSongs2() endpoint Song/
     * Artist Radio use (see startSongRadio()/startArtistRadio()), seeded
     * from the last song already queued rather than the one currently
     * playing — continues whatever's already lined up next instead of
     * jumping back to the vibe of a song several tracks ago. A no-op
     * (returns immediately) unless the setting's on, the server can
     * actually do it, there's no repeat mode already keeping the queue
     * from ever running out, and there's little enough left to actually
     * be worth topping up — see the guards below and
     * AUTOPLAY_TRIGGER_REMAINING's own comment. */
    async maybeAutoplay(): Promise<void> {
      if (this.radioStation) return // no queue concept to extend
      if (this.repeatMode !== 'off') return // never runs out on its own
      const autoplay = useAutoplayStore()
      if (!autoplay.enabled) return
      if (!useAuthStore().capabilities.songRadio) return
      if (this.currentIndex < 0) return
      if (this.queue.length - 1 - this.currentIndex > AUTOPLAY_TRIGGER_REMAINING) return
      if (autoplayLock.isLocked()) return // already topping up from an earlier call

      const seed = this.queue[this.queue.length - 1]
      if (!seed) return
      autoplayLock.acquire()
      try {
        const { songs: similar, plexPassRequired } = await useLibraryStore()
          .client()
          .getSimilarSongs2(seed.id, autoplay.batchSize)
        if (plexPassRequired) {
          // Unlike Song/Artist Radio's own one-shot notify-and-move-on
          // (startSongRadio()/startArtistRadio()), Autoplay is a standing
          // setting — leaving it on would just mean the exact same 403
          // again at the next song change, and the one right after that,
          // for as long as playback continues. Switching it back off is
          // what actually stops the repeat performance; the toast is what
          // explains why it turned itself off rather than that just being
          // silently confusing.
          this.setAutoplayEnabled(false)
          notifyPlexPassRequired('player.autoplay')
          return
        }
        // Filtered by id, not just dedupeForQueue()'s object-identity
        // dedup below (which only stops the *same* Song object landing in
        // the queue twice, not a genuine repeat) — otherwise a small
        // library's similar-songs pool keeps circling back to whatever's
        // already just been played, and autoplay would spend its fetches
        // re-adding songs still sitting right there in the queue instead
        // of actually extending it.
        const existingIds = new Set(this.queue.map((t) => t.id))
        const fresh = similar.filter((t) => !existingIds.has(t.id))
        if (fresh.length) this.addToQueue(fresh)
      } catch (error) {
        console.error('[playback] Autoplay top-up failed:', error)
      } finally {
        autoplayLock.release()
      }
    },

    /** Inserts `songs` right after the currently playing one — "Play next",
     * as opposed to addToQueue() which appends at the end. */
    queueNext(songs: Song[]): void {
      if (this.currentIndex < 0) {
        this.addToQueue(songs) // peeks on its own, see its own comment
        return
      }
      const toInsert = dedupeForQueue(songs, this.queue)
      this.queue.splice(this.currentIndex + 1, 0, ...toInsert)
      const current = this.currentSong
      const originalIndex = current ? this.originalQueue.findIndex((t) => t.id === current.id) : -1
      if (originalIndex >= 0) {
        this.originalQueue.splice(originalIndex + 1, 0, ...toInsert)
      } else {
        this.originalQueue.push(...toInsert)
      }
      this.syncCastQueue()
      useDrawersStore().peekQueueDrawer(toInsert)
    },

    removeFromQueue(index: number): void {
      if (index === this.currentIndex) return // can't remove what's playing
      const [removed] = this.queue.splice(index, 1)
      if (index < this.currentIndex) this.currentIndex -= 1
      if (removed) {
        const originalIndex = this.originalQueue.findIndex((t) => t.id === removed.id)
        if (originalIndex >= 0) this.originalQueue.splice(originalIndex, 1)
      }
      this.syncCastQueue()
    },

    reorderQueue(from: number, to: number): void {
      const [moved] = this.queue.splice(from, 1)
      if (!moved) return
      this.queue.splice(to, 0, moved)
      if (from === this.currentIndex) this.currentIndex = to
      else if (from < this.currentIndex && to >= this.currentIndex) this.currentIndex -= 1
      else if (from > this.currentIndex && to <= this.currentIndex) this.currentIndex += 1
      this.syncCastQueue()
    },

    /** Pushes the full queue to the connect backend whenever it's casting —
     * otherwise connect's own auto-advance (_advance_or_end() in
     * routes/stream.py, see AppState.queue's comment) keeps stepping through
     * whichever queue was last sent at startCurrent() time, and every
     * *other* client sharing this session keeps showing a stale queue too
     * (see build_status_dict()/adoptCastQueue()) — both invisible right up
     * until connect auto-advances on its own to the wrong song (e.g. the
     * controlling phone's screen locks before a manual skip would have
     * caught it) or someone notices the two clients disagree. A
     * `superseded` response (another client's own more recent edit already
     * won — see services/connect/playback.ts's updateQueue()) needs no
     * action here: the next real SSE status tick already carries whichever
     * queue actually won, and adoptCastQueue() picks it up from there. No-op
     * once nothing's actually playing yet (currentIndex < 0) —
     * startCurrent() sends the initial queue itself. */
    syncCastQueue(): void {
      if (!this.isCasting || this.currentIndex < 0) return
      const {
        fullQueue,
        queueIndex,
        originalQueue,
        shuffle,
        repeatMode,
        autoplayEnabled,
        autoplayBatchSize,
      } = this.castQueuePayload
      void connectPlayback
        .updateQueue(fullQueue, queueIndex, {
          originalQueue,
          shuffle,
          repeatMode,
          autoplayEnabled,
          autoplayBatchSize,
        })
        .catch((error) => {
          console.error('[playback] Failed to sync queue to connect:', error)
        })
    },

    /** Drops everything from the queue except whatever's currently playing
     * — same "can't remove what's playing" rule removeFromQueue() already
     * enforces per-row, just applied to the whole queue at once. Radio has
     * no queue to clear (this.queue is already empty then; QueueDrawer.vue
     * only shows the button at all once there's more than the current
     * song to drop, see its own guard). Like every other queue-mutating
     * action here, pushes the result to connect via syncCastQueue() —
     * without it, this client's own next status tick would still carry the
     * pre-clear queue and adoptCastQueue() would restore it a few seconds
     * later, undoing the clear. */
    clearQueue(): void {
      const current = this.currentSong
      if (!current) {
        this.originalQueue = []
        this.queue = []
        this.currentIndex = -1
        this.syncCastQueue()
        return
      }
      this.originalQueue = [current]
      this.queue = [current]
      this.currentIndex = 0
      this.syncCastQueue()
    },

    async stop(): Promise<void> {
      const connect = useConnectStore()
      if (connect.isActive) {
        // Also stops this session's radio-metadata watch on the backend,
        // if one was running — see routes/playback.py's /stop.
        await connectPlayback.stop()
      } else {
        getAudioEngine().stop()
        if (this.radioStation) stopRadioMetadataWatch()
      }
      this.isPlaying = false
      this.localPosition = 0
      this.bufferedPosition = 0
      this.radioNowPlaying = null
      // Same reasoning as handOffToLocalPlayback()'s identical reset —
      // nothing is casting (or playing at all) any more to still be
      // filling a startup buffer, and the SSE handler that normally clears
      // this stopped updating the moment casting became inactive.
      this.radioBuffering = false
    },

    /** Called from authStore.logout() — without this, the queue/currentSong
     * from the account signing out stay in memory (this store is a
     * singleton for the app's whole lifetime, its init() only ever runs
     * once), so a different account logging in afterwards would see the
     * previous one's "now playing" and could try to stream a song id that
     * doesn't belong to them. Only stops local playback — leaves an active
     * cast target alone, since a physical speaker doesn't care which
     * account is signed into this window. */
    resetForLogout(): void {
      getAudioEngine().stop()
      useDrawersStore().resetDrawers()
      this.$reset()
    },

    /** Re-derives account-scoped local state — the persisted queue/position
     * snapshot, and the local/cast quality preference — for whichever
     * account is *actually* logged in. See services/accountKey.ts's
     * onAccountChange(): this store gets created at app boot (App.vue's
     * created() calling init()), before login/restore() has resolved an
     * account, so restoreFromStorage()/state()'s own loadStreamQuality()
     * call run too early to see the real account's own data. Deliberately
     * does *not* call decideLocalResume()/resumeLocalPlayback() itself —
     * only restore()'s own attemptLocalResumeAfterAuth() (auth.ts) decides
     * whether to actually start audio, and only for a silent boot restore,
     * never a fresh login (see that call site's own comment) — this only
     * repopulates state, exactly like restoreFromStorage() already does. */
    reloadAccountScoped(): void {
      this.restoreFromStorage()
      const quality = loadStreamQuality()
      this.localQuality = quality.local
      this.castQuality = quality.cast
      getAudioEngine().setVolume(this.volume)
    },

    /** Hands the currently loaded local song/radio off to the given cast
     * targets, or just claims them ahead of playback if nothing is loaded
     * yet — called by ConnectDevicePicker's "Connect"/"Add" action. Routed
     * through connect.withTakeoverHandling() (like claimDevices() already
     * is) so a device claimed by another session opens the takeover-confirm
     * dialog instead of the conflict just failing silently — unless `force`
     * is already true (the device-row "Take over" action decided that
     * up front), in which case there's nothing left to detect. */
    /** A cast device stopped without anyone asking it to (see
     * ConnectStatus.interrupted). Beacon cannot tell that apart from
     * somebody pressing stop on the speaker itself, so it does not resume on
     * its own - it says so and offers to, and the person decides.
     *
     * A long timeout on purpose: this asks a question rather than reporting
     * something, and the default is calibrated for glancing at a
     * notification, not for noticing one, reading it and acting on it. It
     * also stops counting down while the pointer is over it. */
    notifyCastInterrupted(): void {
      // Kept as state, not just a toast: the phone remote is fed debounced
      // *snapshots*, so a one-shot event would simply never reach it. This
      // is what both surfaces read - the desktop/mobile toast fires once
      // from here, the phone renders a banner for as long as it stands.
      this.castInterrupted = true
      const connect = useConnectStore()
      const where = connect.activeTargets.map((t) => t.name).join(', ')
      emitter.emit('toast', {
        level: 'error',
        title: i18n.global.t('connect.interruptedTitle'),
        message: where
          ? i18n.global.t('connect.interruptedOn', { device: where })
          : i18n.global.t('connect.interrupted'),
        timeoutMs: 45000,
        action: {
          label: i18n.global.t('connect.interruptedResume'),
          onClick: () => {
            void this.resumeAfterInterruption().catch(() => {
              emitter.emit('toast', [
                'error',
                i18n.global.t('connect.interruptedTitle'),
                i18n.global.t('connect.interruptedResumeFailed'),
              ])
            })
          },
        },
      })
    },

    /** Pick playback back up after castInterrupted. Shared by the toast on
     * desktop/mobile and the phone remote's banner, so the flag is cleared
     * in exactly one place however the request arrived. */
    async resumeAfterInterruption(): Promise<void> {
      await connectPlayback.resumeInterrupted()
      this.castInterrupted = false
    },

    async castTo(targets: ConnectDeviceRef[], force = false): Promise<void> {
      // Any deliberate dispatch supersedes a pending interruption - whatever
      // was interrupted is not what is about to play.
      this.castInterrupted = false
      const connect = useConnectStore()
      // Captured before either play() attempt (including a takeover retry)
      // — connect's /play always starts the device playing immediately,
      // there's no "load paused" for these cast protocols, so a handoff
      // that was paused locally needs its own explicit /pause right back
      // afterwards instead of just inheriting whatever /play did. Without
      // this, picking a cast target while paused silently resumed playback
      // the user had deliberately paused.
      const wasPlaying = this.isPlaying
      if (this.radioStation) {
        // Radio dispatches even when paused, unlike the track branch below
        // — see connectPlayback.play()'s `paused` option for why, and for
        // what that costs here: a moment of the station on the speaker
        // before the /pause lands.
        const station = this.radioStation
        const play = async (f: boolean) => {
          if (this.isPlaying) getAudioEngine().pause() // local pauses, connect takes over
          const response = await connectPlayback.playUrl(station.streamUrl, station.name, {
            targets,
            force: f,
            castDirectly: useRadioSettingsStore().castDirectly,
          })
          // Superseded by a newer dispatch — another client sharing this
          // connect session, most likely (see startCurrent()'s identical
          // check/docstring) — nothing actually changed here, so isPlaying
          // stays whatever it already was instead of guessing.
          if (response.status === 'superseded') return
          if (wasPlaying) {
            this.isPlaying = true
          } else {
            await connectPlayback.pause()
            this.isPlaying = false
          }
        }
        if (force) await play(true)
        else await connect.withTakeoverHandling(play)
      } else if (this.currentSong) {
        const song = this.currentSong
        const startPosition = this.localPosition
        const gain = this.replayGainMultiplier
        const {
          fullQueue,
          queueIndex,
          originalQueue,
          shuffle,
          repeatMode,
          autoplayEnabled,
          autoplayBatchSize,
        } = this.castQueuePayload
        const play = async (f: boolean) => {
          if (this.isPlaying) getAudioEngine().pause() // local pauses, connect takes over
          const response = await connectPlayback.play(song.id, {
            targets,
            startPosition,
            force: f,
            gain,
            fullQueue,
            queueIndex,
            originalQueue,
            shuffle,
            repeatMode,
            autoplayEnabled,
            autoplayBatchSize,
            // Handed over as a reservation rather than as playback when
            // this device was paused: the speaker is claimed and holds the
            // track, and the next /resume is what starts it. This used to
            // be a dispatch followed by connectPlayback.pause() below,
            // which the speaker plays an audible moment of — see that
            // option's own comment.
            paused: !wasPlaying,
          })
          // See the radio branch's identical check above.
          if (response.status === 'superseded') return
          this.isPlaying = wasPlaying
        }
        if (force) await play(true)
        else await connect.withTakeoverHandling(play)
      } else {
        await connect.claimDevices(targets)
      }
    },

    /** Move the active cast targets to exactly `desired`, as one step.
     *
     * Every device picker in the app is a desired-state editor: the phone's
     * and the mobile web UI's have always been ("what's checked when I hit
     * Done"), and the desktop's now is too. This is the single place that
     * turns such a set into calls, so those three surfaces can't drift apart
     * again — they previously did, and the desktop's picker applied its
     * selection with castTo(), which *replaces* the target set. Adding a
     * second speaker to a running session therefore dropped the first one
     * instead of joining it: playback carried on there until the end of the
     * track (its stream connection was still open) and then only the newly
     * picked device kept playing.
     *
     * Additions go first and removals second, deliberately. The reverse
     * order would empty the target set in between when switching from one
     * device to another, and an empty set is not a neutral intermediate
     * state — it hands playback straight back to local speakers, which is
     * audible and is exactly what made "switch devices" unusable before.
     *
     * A join that can't go through abandons the removals with it, for the
     * same reason. Two ways that happens, and neither may be allowed to
     * fall through to the second loop: a hard failure throws out of here,
     * and a device claimed by another session comes back as `false` with
     * connect.pendingTakeover now waiting on the user's confirmation (see
     * withTakeoverHandling()). Carrying on past either one stops the
     * device that *is* playing on behalf of one that never started —
     * playback drops to local speakers mid-switch, and confirming the
     * takeover afterwards then finds no stream left to join at all
     * (routes/join.py refuses a session that isn't streaming). So the
     * takeover's retry is swapped for a full, forced re-apply: it picks up
     * whatever this pass already joined and finishes the rest, removals
     * included.
     */
    async applyTargets(desired: ConnectDeviceRef[], force = false): Promise<void> {
      const connect = useConnectStore()
      const key = (t: ConnectDeviceRef) => `${t.type}:${t.name}`
      const active = connect.activeTargets as ConnectDeviceRef[]

      if (desired.length === 0) {
        if (active.length > 0) await connect.stopAll()
        return
      }
      // Nothing running yet: this is a fresh cast, not an edit. castTo()
      // carries the queue, position and paused-state handoff that /join
      // has no reason to.
      if (active.length === 0) {
        await this.castTo(desired, force)
        return
      }

      const desiredKeys = new Set(desired.map(key))
      const activeKeys = new Set(active.map(key))
      for (const target of desired.filter((t) => !activeKeys.has(key(t)))) {
        const joined = await connect.joinDevice(target, force)
        if (!joined) {
          connect.setTakeoverRetry(() => this.applyTargets(desired, true))
          return
        }
      }
      for (const target of active.filter((t) => !desiredKeys.has(key(t)))) {
        await connect.stopDevice(target.type, target.name)
      }
    },
  },
})

/** Clones any song in `songs` that's already the same object reference as
 * something in `existingQueue` (or repeated within `songs` itself), so
 * addToQueue()/queueNext() never push the literal same Song object into
 * the queue twice. Two queue slots sharing one object reference is what let
 * QueueDrawer.vue's per-row identity (keyed off the object, not `id` —
 * needed since the same *song* can legitimately be queued more than once)
 * collide between unrelated rows. Only clones on an actual collision — the
 * overwhelmingly common case (no repeats) still pushes the original
 * reference unchanged, same as before this existed. */
export function dedupeForQueue(songs: Song[], existingQueue: Song[]): Song[] {
  const seen = new Set<Song>(existingQueue)
  return songs.map((t) => {
    if (seen.has(t)) return { ...t }
    seen.add(t)
    return t
  })
}

export function shuffledExcept(songs: Song[], keepFirst: Song | null | undefined): Song[] {
  // Removes only the one `keepFirst` instance, not every song sharing its
  // id — a plain .filter() by id would drop *every* occurrence, silently
  // shrinking the queue whenever the same song appears twice in it.
  const rest = [...songs]
  if (keepFirst) {
    const keepIndex = rest.findIndex((t) => t.id === keepFirst.id)
    if (keepIndex >= 0) rest.splice(keepIndex, 1)
  }
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j]!, rest[i]!]
  }
  return keepFirst ? [keepFirst, ...rest] : rest
}
