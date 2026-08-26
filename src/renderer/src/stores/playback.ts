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
  type TranscodeFormat,
} from '@/services/streamQuality'
import { useLibraryStore } from './library'
import { useConnectStore } from './connect'
import { useAuthStore } from './auth'
import { useAutoplayStore } from './autoplay'
import * as connectPlayback from '@/services/connect/playback'
import type { ConnectDeviceRef, ConnectStatus, PlayResponse } from '@/services/connect/types'
import type { Artist, RadioStation, Song } from '@/types/library'
import { emitter } from '@/emitter'
import { i18n } from '@/i18n'
import { initMediaSession } from '@/services/mediaSession'
import { createPositionTracker } from './positionTracker'
import { createSequenceGuard } from './sequenceGuard'
import { createKeyedGuard } from './keyedGuard'
import { createLock } from './lock'
import { createEdgeDetector } from './edgeDetector'
import { diffCastQueue } from './queueReconcile'

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

type RepeatMode = 'off' | 'all' | 'one'

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
  initialized: boolean
  queueDrawerOpen: boolean
  // Bumped by peekQueueDrawer() specifically — QueueDrawer.vue watches
  // this (not queueDrawerOpen) to know a staggered reveal is actually
  // warranted, as opposed to a plain manual toggle-open of an otherwise
  // unchanged queue, which should just show it as-is with no fanfare.
  queueRevealSeq: number
  // Whether *this* peekQueueDrawer() call is the one actually opening the
  // drawer from closed, set alongside queueRevealSeq above — see
  // QueueDrawer.vue's own startReveal(), which needs to wait out the
  // drawer's own opening transition before revealing anything in that
  // case, but not when the drawer was already open and visible (a
  // mid-queue "Play Next" while watching it, say) and the reveal should
  // just start immediately instead.
  queueRevealNeedsOpenDelay: boolean
  // Exactly which songs QueueDrawer.vue's reveal animation should treat as
  // new, set by peekQueueDrawer() at the same moment as queueRevealSeq —
  // see that action's own comment on why this has to be an explicit list
  // handed down from here, not something QueueDrawer.vue can work out for
  // itself by watching what it's already rendered.
  queueRevealSongs: Song[]
  lyricsDrawerOpen: boolean
}

// Scrubbing backwards restarts the current song instead of jumping to the
// previous one once you're more than this far in — matches how every other
// music player's "previous" button behaves.
const RESTART_THRESHOLD_SECONDS = 3

// maybeAutoplay() tops the queue back up once at most this many songs are
// left after the current one — 1, not 0, so there's a whole song's worth of
// lead time for the getSimilarSongs2() round trip to finish before the
// queue would otherwise actually run dry.
const AUTOPLAY_TRIGGER_REMAINING = 1

// How long peekQueueDrawer() leaves the drawer open before auto-closing it
// again, absent a mouseenter (cancelQueueDrawerAutoCloseTimer()) telling it
// the user's actually looking. Long enough to register "oh, that's what got
// picked" at a glance, short enough not to just sit open indefinitely for
// someone who's moved on.
const QUEUE_DRAWER_PEEK_MS = 4000

// setTimeout handle for the above — module-level, not store state: a plain
// timer id isn't something Pinia needs to track/persist/react to, same
// reasoning as endedEdge below.
let queueDrawerAutoCloseTimer: ReturnType<typeof setTimeout> | null = null

function cancelQueueDrawerAutoCloseTimer(): void {
  if (queueDrawerAutoCloseTimer === null) return
  clearTimeout(queueDrawerAutoCloseTimer)
  queueDrawerAutoCloseTimer = null
}

function armQueueDrawerAutoCloseTimer(store: { queueDrawerOpen: boolean }): void {
  cancelQueueDrawerAutoCloseTimer()
  queueDrawerAutoCloseTimer = setTimeout(() => {
    queueDrawerAutoCloseTimer = null
    store.queueDrawerOpen = false
  }, QUEUE_DRAWER_PEEK_MS)
}

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

// localStorage key for the persisted queue/position snapshot (see init()'s
// $subscribe and restoreFromStorage()) — lets a reload (or app restart)
// pick local playback back up close to where it left off, since a reload
// necessarily destroys the <audio> element and stops it for a moment.
const PERSIST_KEY = 'beacon.playback'

interface PersistedPlaybackState {
  queue: Song[]
  originalQueue: Song[]
  currentIndex: number
  radioStation: RadioStation | null
  shuffle: boolean
  repeatMode: RepeatMode
  volume: number
  replayGainMode: ReplayGainMode
  localPosition: number
  wasPlaying: boolean
}

function loadPersisted(): PersistedPlaybackState | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    return raw ? (JSON.parse(raw) as PersistedPlaybackState) : null
  } catch {
    return null
  }
}

function savePersisted(snapshot: PersistedPlaybackState): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(snapshot))
  } catch {
    // Storage full/unavailable — losing resume-on-reload is an acceptable
    // degradation, not worth surfacing to the user.
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

let persistTimer: ReturnType<typeof setTimeout> | null = null
// Whether the persisted snapshot being restored had audio actually playing
// (vs. loaded-but-paused) — read once by resumeLocalPlayback().
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
      initialized: false,
      queueDrawerOpen: false,
      queueRevealSeq: 0,
      queueRevealNeedsOpenDelay: false,
      queueRevealSongs: [],
      lyricsDrawerOpen: false,
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
    /** The cast quality ceiling in the shape connect's /play expects, or an
     * empty object when there is none — connect treats both fields missing
     * as "no ceiling" and behaves exactly as it did before they existed
     * (see resolve_output_format()), so spreading nothing is the correct
     * way to say "don't cap this". */
    castQualityPayload(state): {
      max_lossy_format?: TranscodeFormat
      max_lossy_bitrate_kbps?: number
    } {
      if (state.castQuality.format === 'original') return {}
      return {
        max_lossy_format: state.castQuality.format,
        max_lossy_bitrate_kbps: state.castQuality.bitrate,
      }
    },
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
    castQueuePayload(state): {
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
        autoplayBatchSize: autoplay.batchSize,
      }
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

      // Explicit, not just relying on state()'s own defaults — these were
      // never meant to be restored across a restart (restoreFromStorage()
      // below doesn't touch them), only toggled during the running
      // session, so a fresh app start should always begin with both closed.
      this.queueDrawerOpen = false
      this.lyricsDrawerOpen = false

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
      engine.onEnded = () => {
        if (!this.isCasting) void this.advanceOnSongEnd()
      }
      engine.onError = (message) => {
        console.error('[playback]', message)
        this.isPlaying = false
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
        this.localPosition = status.elapsed
        positionTracker.record(status.elapsed, performance.now())
        if (status.current_song) this.duration = status.current_song.duration
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
     * any playback. */
    restoreFromStorage(): void {
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
      restoredWasPlaying = saved.wasPlaying
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
        // Not just this.isPlaying — resumeLocalPlayback() (the only reader
        // of this flag) uses it to decide whether to auto-play through the
        // *local* <audio> element on next boot. Persisting it while casting
        // would auto-start local speaker playback next launch even though
        // local playback was never actually happening last session (only
        // the cast device was audible) — this.isPlaying is true in both
        // cases, so it alone can't tell the two apart.
        wasPlaying: this.isPlaying && !this.isCasting,
      })
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

    /** Actually resumes (or pre-loads) local <audio> playback from the
     * snapshot restoreFromStorage() put into state — only called once we
     * know a cast session isn't already handling it (see
     * decideLocalResume()). Resumes playing if it was mid-playback before
     * the reload; otherwise just loads the song/position so hitting play
     * afterwards has something to resume instead of an empty element. */
    async resumeLocalPlayback(): Promise<void> {
      if (this.radioStation) {
        // No stable "position" to preload for a live stream — only
        // meaningful to auto-reconnect if it was actually playing.
        if (restoredWasPlaying) {
          getAudioEngine().play(this.radioStation.streamUrl)
          this.isPlaying = true
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
        if (this.isPlaying) getAudioEngine().play(this.radioStation.streamUrl)
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
          this.radioStation = {
            id: '',
            name: status.radio.title,
            streamUrl: status.radio.url,
            homePageUrl: null,
          }
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

    /** `peek` opens the queue drawer on the new queue — for callers whose
     * pick the user didn't make song-by-song themselves (see
     * peekQueueDrawer()'s own comment for that distinction). It has to
     * happen here rather than in the caller, right after the mutation and
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
      if (peek) this.peekQueueDrawer()
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
      this.originalQueue = []
      this.queue = []
      this.currentIndex = -1
      this.radioStation = station
      this.localPosition = 0

      if (connect.isActive) {
        await connectPlayback.playUrl(station.streamUrl, station.name, {
          targets: connect.activeTargets,
        })
      } else {
        getAudioEngine().play(station.streamUrl)
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
      this.peekQueueDrawer(toAdd)
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
          autoplay.setEnabled(false)
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
      this.peekQueueDrawer(toInsert)
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
        await connectPlayback.stop()
      } else {
        getAudioEngine().stop()
      }
      this.isPlaying = false
      this.localPosition = 0
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
      cancelQueueDrawerAutoCloseTimer()
      this.$reset()
    },

    // Routes every manual open/close through here (DefaultLayout.vue's own
    // v-model listener, toggleQueueDrawer() below) instead of setting
    // queueDrawerOpen directly, so a still-pending peekQueueDrawer() timer
    // (see its own comment) always gets cancelled first — without this, a
    // stale timer could auto-close a drawer the user had just reopened
    // manually within that same few-second window.
    setQueueDrawerOpen(open: boolean): void {
      cancelQueueDrawerAutoCloseTimer()
      this.queueDrawerOpen = open
    },

    toggleQueueDrawer(): void {
      this.setQueueDrawerOpen(!this.queueDrawerOpen)
    },

    // Called by every action that changes the queue in a way that isn't
    // already obvious from whatever the user was just looking at:
    // addToQueue()/queueNext() (a song's context menu, the mobile action
    // sheet, remote-control commands, and maybeAutoplay()'s own top-up,
    // all funneled through those two), startSongRadio()/
    // startArtistRadio() (a server-picked mix), and the Songs/Genre/
    // Albums/Artists views' own "play random"/"play from top played"
    // actions. Those last three all reach it through playSongList()'s own
    // opt-in `peek` argument (see its comment for why the peek has to
    // happen inside that call rather than after it); playSongList() never
    // peeks on its own, since its more direct callers (clicking a
    // song/album/playlist you were already looking at) already show you
    // exactly what's about to play, so peeking there would just be noise.
    // queueRevealSeq always bumps (that's the "show me what got added"
    // signal QueueDrawer.vue's own reveal animation watches for — see its
    // own comment), even if the drawer was already open from an earlier
    // peek/manual toggle. The auto-close timer only arms when this call is
    // the one actually opening it, though: a drawer the user already had
    // open manually is left alone entirely otherwise — imposing an
    // auto-close on state they set up themselves would be surprising.
    // `revealSongs` is exactly which songs QueueDrawer.vue's reveal
    // animation should treat as new — omit it (every replace-the-whole-
    // queue caller: startSongRadio(), startArtistRadio(), every "play
    // random"/"play from top played" action) to mean "the entire current
    // queue", since every one of those really did just become entirely
    // new. addToQueue()/queueNext() pass the specific songs they just
    // added instead, so only those get revealed — not rows that were
    // already sitting there and merely shifted position.
    //
    // This can't be inferred by QueueDrawer.vue itself from what it has or
    // hasn't rendered yet (an earlier version tried exactly that, checking
    // a WeakMap of already-seen Song objects): by the time it renders, the
    // songs are simply there, with nothing marking which of them the user
    // hasn't seen before. Reported live 2026-08-25 as "no animation when
    // the queue regenerates while the drawer's open".
    //
    // Every caller has to reach here in the same synchronous tick as its
    // own queue mutation, so that both land in one render — the reveal is
    // just per-row transition delays (see QueueDrawer.vue), which do
    // nothing for a row Vue already rendered and animated an await ago.
    peekQueueDrawer(revealSongs?: Song[]): void {
      const wasAlreadyOpen = this.queueDrawerOpen
      this.queueDrawerOpen = true
      this.queueRevealNeedsOpenDelay = !wasAlreadyOpen
      this.queueRevealSongs = revealSongs ?? this.queue
      this.queueRevealSeq++
      if (!wasAlreadyOpen) armQueueDrawerAutoCloseTimer(this)
    },

    // QueueDrawer.vue's own @mouseenter — one touch of the mouse is enough
    // to mean "I'm actually looking at this", cancelling the pending
    // auto-close for good (not just deferring it), so it then stays open
    // the same as if it had been opened manually.
    cancelQueueDrawerAutoClose(): void {
      cancelQueueDrawerAutoCloseTimer()
    },

    toggleLyricsDrawer(): void {
      this.lyricsDrawerOpen = !this.lyricsDrawerOpen
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
        const station = this.radioStation
        const play = async (f: boolean) => {
          if (this.isPlaying) getAudioEngine().pause() // local pauses, connect takes over
          const response = await connectPlayback.playUrl(station.streamUrl, station.name, {
            targets,
            force: f,
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
          })
          // See the radio branch's identical check above.
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
        await connect.joinDevice(target)
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
