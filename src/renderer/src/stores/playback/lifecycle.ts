/** Starting up, restoring the last session, saving, and logging out. */
import { getAudioEngine } from '@/services/audioEngine'
import { load as loadStreamQuality } from '@/services/streamQuality'
import { useConnectStore } from '../connect'
import { useEqualizerStore } from '../equalizer'
import { useDrawersStore } from '../drawers'
import { useRadioMetadataStore } from '../radioMetadata'
import type { ConnectStatus } from '@/services/connect/types'
import type { Song } from '@/types/library'
import { initMediaSession, reassertActionHandlers } from '@/services/mediaSession'
import { createEdgeDetector } from '@/services/playback/edgeDetector'
import { getLocalMix } from '@/services/playback/localMix'
import { reportRadioSilence } from '@/services/connect/radio'
import { pollingAllowed } from '@/services/connect/pollGate'
import {
  loadPersisted,
  readSessionWasPlaying,
  savePersisted,
  writeSessionWasPlaying,
} from '@/services/playback/persistence'
import { markQueueRestored } from '@/services/playback/serverQueueSync'
import { autoplayExhaustedSeedIds, localRadioChangeGuard, positionTracker } from './shared'
import { runtime } from './shared'
import type { PlaybackContext } from './context'

// Edge-detects status.ended's false→true transition across SSE updates
// (module-level: the SSE subscription in init() is set up once per app
// lifetime, not per store-consumer, so this doesn't belong in state).
const endedEdge = createEdgeDetector()

let persistTimer: ReturnType<typeof setTimeout> | null = null

// Sequences with connect's first SSE status tick (or a timeout, whichever
// comes first) so local resume only ever gets decided once — see
// decideLocalResume()/attemptLocalResumeAfterAuth().
let localResumeDecided = false

// Tracks connect.isActive across SSE ticks so a live true→false transition
// (user hit "Stop casting"/disconnected the last device mid-session) can be
// told apart from merely observing "not casting" on app boot, which
// decideLocalResume() already owns — see applyCastStatus().
const castingActiveEdge = createEdgeDetector()

// The last status payload whose `interrupted` flag was already acted on.
// applyCastStatus() runs on *every* mutation of the connect
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

// The same "once per payload, not once per mutation" rule for the position,
// and for a sharper reason than the toast above: status.elapsed is a
// snapshot of where playback was when that payload was *built*, and
// positionTracker measures every report against the wall clock (see its own
// comment). Re-recording the same elapsed later — which every unrelated
// mutation of the connect store did, and the device picker alone produces
// one every 4s while it's open (ConnectDevicePicker.vue's own poll) — hands
// it a position that has since fallen behind by however long ago the real
// tick was. Past MAX_SMOOTHED_REWIND_SECONDS that reads as a real backwards
// move and is followed: the counter jumps back a second or two, taking the
// lyrics highlight with it, which is the very thing the smoothing exists to
// prevent.
let positionPayloadHandled: unknown = null

export interface LifecycleActions {
  init(): void
  wireAudioEngine(): void
  applyCastStatus(status: ConnectStatus | null): void
  startBackgroundTimers(): void
  persistOnChange(): void
  restoreFromStorage(): void
  adoptServerQueue(songs: Song[], index: number, position: number): void
  persistNow(): void
  attemptLocalResumeAfterAuth(): void
  decideLocalResume(): void
  resumeLocalPlayback(): Promise<void>
  resetForLogout(): void
  reloadAccountScoped(): void
}

export const lifecycleActions: LifecycleActions & ThisType<PlaybackContext> = {
  /** Wires the shared AudioEngine for local playback, restores the last
   * session's queue/position (see restoreFromStorage()), and subscribes
   * to connect SSE status to mirror cast playback state + auto-advance
   * the queue on song-end. Call once (App.vue). */
  init(): void {
    if (this.initialized) return
    this.initialized = true

    // Explicit, not just relying on the drawer store having been created
    // in its own default state — a reload of the renderer alone (an
    // update, an HMR round) leaves a store that has been running. The
    // queue drawer's own remembered position survives this (see
    // stores/drawers.ts's resetDrawers); the rest is per-session and
    // starts empty.
    useDrawersStore().resetDrawers()

    this.restoreFromStorage()

    this.wireAudioEngine()

    // OS media keys / lock-screen / GNOME-KDE media widget — see that
    // service's own comment. Works the same whether casting or playing
    // locally (both keep currentSong/isPlaying current either way), so
    // this needs no isCasting branch of its own the way
    // wireAudioEngine()'s callbacks do.
    initMediaSession()

    // detached: true, same reason as persistOnChange()'s —
    // init() runs from App.vue's created(), so without it Pinia ties this
    // subscription to that component instance and drops it when the
    // instance goes away (an HMR round reloading App.vue does exactly
    // that). The `initialized` guard above then keeps it from ever being
    // set up again, leaving the store deaf to every further status tick
    // while the backend keeps a cast playing — observed live 2026-09-07 as
    // a player bar stuck at one track's end for the rest of the queue.
    useConnectStore().$subscribe((_mutation, state) => this.applyCastStatus(state.status), {
      detached: true,
    })

    this.startBackgroundTimers()
    this.persistOnChange()
  },

  /** Routes the shared AudioEngine's events into this store - each one
   * only while playing locally, since casting reports through connect. */
  wireAudioEngine(): void {
    const engine = getAudioEngine()
    engine.setVolume(this.volume)
    useEqualizerStore().applyLocal()
    engine.onTimeUpdate = (position) => {
      if (!this.isCasting) {
        if (getLocalMix().active) this.followLocalMix(position)
        else this.localPosition = position
        this.checkScrobbleThreshold()
      }
    }
    // connect lost this device's mix (stopped, or restarted) while it
    // was still playing here: start it over from where it was.
    getLocalMix().onLost = () => {
      if (this.preview) {
        this.endPreview()
        return
      }
      if (!this.isCasting && this.currentSong) {
        this.startLocalSong(this.currentSong, this.localPosition, this.isPlaying)
      }
    }
    engine.onDurationChange = (duration) => {
      if (!this.isCasting) this.duration = duration
    }
    engine.onBufferedChange = (end) => {
      if (this.isCasting) return
      runtime.mixBufferedEnd = end
      this.bufferedPosition = getLocalMix().active ? this.mixBufferedPosition() : end
    }
    engine.onEnded = () => {
      if (this.preview) this.endPreview()
      else if (!this.isCasting) void this.advanceOnSongEnd()
    }
    // The lock screen's previous/next only appear once registered after
    // playback has begun - see reassertActionHandlers().
    engine.onPlaying = () => reassertActionHandlers()
    engine.onExternalPause = () => {
      if (this.isCasting) return
      getLocalMix().pause()
      this.isPlaying = false
    }
    engine.onError = (message) => {
      console.error('[playback]', message)
      this.isPlaying = false
    }
    // Radio only, same as radioBuffering's own cast-side source (SSE
    // status.radio_buffering, see applyCastStatus()) — a song's own reconnect stays
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
    // The other end of the same story: the ladder ran out. Radio only for
    // the same reason as above — a song that cannot be reconnected is
    // one the listener can play again from the queue, so there is nothing
    // to offer them that they do not already have.
    engine.onConnectionLost = () => {
      if (!this.isCasting && this.radioStation) this.radioConnectionLost = true
    }
    // Into connect's log, next to the relay's own lines - see
    // reportRadioSilence() for why only this side can measure it.
    engine.onSilence = (seconds) => {
      if (!this.isCasting && this.radioStation && runtime.radioConnectionId) {
        reportRadioSilence(runtime.radioConnectionId, seconds)
      }
    }
  },

  /** Mirrors one connect status tick: the cast/local handover, an
   * interruption, and - while casting - what plays, where it is, and
   * whether it ended. Runs on every connect store mutation, so anything
   * per-payload is guarded by payload identity. */
  applyCastStatus(status: ConnectStatus | null): void {
    // As soon as we know for sure whether a cast session already owns
    // playback (the first real status tick), decide whether local
    // <audio> should resume instead — see decideLocalResume().
    if (status) this.decideLocalResume()

    const connect = useConnectStore()
    const activeNow = connect.isActive
    // Both directions of the cast/local switch, and each has to be a
    // transition rather than the current value: "wasn't casting at
    // boot" is decideLocalResume()'s above, and local audio has to
    // stop however it came to be playing, which is why the rising side
    // carries no localResumeDecided guard of its own. On the falling
    // side this.localPosition still holds the last position reported
    // while casting — this same tick's early return (right below)
    // skips overwriting it from a now-inactive status — which is where
    // the local element is then loaded at.
    const castingEdge = castingActiveEdge.update(activeNow)
    if (castingEdge === 'rising') this.yieldToCastPlayback()
    if (localResumeDecided && castingEdge === 'falling') this.prepareLocalPlayback()

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
    // A tick still carrying a song while this client is mid-switch to
    // a station was built before /play-url reached the backend, and
    // everything it says about position belongs to the track that is
    // already over — see localRadioChangeGuard. Left in, it wrote the
    // old track's length and elapsed onto a station that has neither,
    // so the "Live · {elapsed}" readout started at wherever the track
    // had got to and counted on from there.
    const supersededByPendingRadio = !!status.current_song && localRadioChangeGuard.hasAny()
    if (status.current_song && !supersededByPendingRadio) {
      this.duration = status.current_song.duration
    }
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
    // previous song's. Once per payload, same as the interruption above
    // — see positionPayloadHandled for what re-recording a stale
    // elapsed does to the tracker.
    if (status !== positionPayloadHandled && !supersededByPendingRadio) {
      positionPayloadHandled = status
      const now = performance.now()
      positionTracker.record(status.elapsed, now)
      this.localPosition = positionTracker.extrapolate(now, this.positionClamp)
    }
    // Not over a preview, whose positions are mid-song - before this
    // client may even have taken it up (adoptCastPreview()).
    if (!status.preview) this.checkScrobbleThreshold()

    void this.reconcileFromStatus(status)

    if (endedEdge.update(status.ended) === 'rising') void this.advanceOnSongEnd()
  },

  /** App-lifetime timers. Each is a no-op while it has nothing to do, so
   * they are simply left running. */
  startBackgroundTimers(): void {
    // Smooths the ~2s-stepped position applyCastStatus() records into something that moves
    // every 200ms instead — see positionTracker.ts's own comment. A no-op
    // whenever not actively cast-playing, so this is cheap to just leave
    // running for the app's whole lifetime rather than starting/stopping
    // it around every play/pause/cast-toggle.
    setInterval(() => {
      if (!this.isCasting || !this.isPlaying || !positionTracker.hasAnchor()) return
      this.localPosition = positionTracker.extrapolate(performance.now(), this.positionClamp)
    }, 200)

    // Polls this session's ICY "now playing" tag and the station's title
    // log for whichever station is current — the round itself belongs to
    // the radio-metadata store; this is only the app-lifetime timer that
    // drives it, alongside the position one above. A no-op whenever no
    // radio is playing, same as that one, so this is cheap to just leave
    // running rather than starting/stopping it around every radio
    // play/stop.
    setInterval(() => {
      // Skipped while the window is hidden or the app is being denied by
      // whatever sits in front of the backend (see pollGate.ts). Nothing
      // renders this title but SongInfo.vue, so a hidden window was
      // asking for it several hundred times an hour for nobody.
      if (pollingAllowed()) useRadioMetadataStore().poll()
    }, 8000)
    // ...which would leave a stale title on screen for up to one interval
    // on the way back, so the return is what refreshes it rather than the
    // next tick after it.
    document.addEventListener('visibilitychange', () => {
      if (pollingAllowed()) useRadioMetadataStore().poll()
    })
  },

  persistOnChange(): void {
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
   * SESSION_WAS_PLAYING_KEY's own comment) into runtime.restoredWasPlaying, ahead
   * of anything in this fresh instance that could overwrite it — read
   * unconditionally, before the early return below, since it's an
   * independent signal from whether a localStorage snapshot exists at
   * all. */
  restoreFromStorage(): void {
    runtime.restoredWasPlaying = readSessionWasPlaying()
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
    // Not for radio: a live stream has no position to come back to, and
    // resumeLocalPlayback() never uses one for it either — it reconnects
    // at the live edge and the elapsed counter starts from zero again
    // (see its own comment). Restored, the number would be how long the
    // *previous* session listened, presented as this one's — reported
    // live 2026-09-05 as a restored-but-not-started station showing a
    // running time it had never played for.
    this.localPosition = saved.radioStation ? 0 : saved.localPosition
    markQueueRestored()
  },

  /** Takes over the queue another app saved on the server (see
   * services/playback/serverQueueSync.ts) - in its order, at its song
   * and position, loaded but not playing - whatever was playing here
   * stops. Not while casting. */
  adoptServerQueue(songs: Song[], index: number, position: number): void {
    this.leaveRadio()
    this.isPlaying = false
    this.preview = null
    autoplayExhaustedSeedIds.clear()
    // The order is the other app's, already shuffled or not; Beacon's own
    // shuffle would claim an original order it doesn't have.
    this.shuffle = false
    this.originalQueue = [...songs]
    this.queue = [...songs]
    this.currentIndex = index
    this.localPosition = position
    const song = this.currentSong
    if (!song) return
    this.duration = song.duration
    this.startLocalSong(song, position, false)
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
      // Never the preview's: a reload is back on the queue's song.
      localPosition: this.preview ? this.preview.resumeAt : this.localPosition,
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
   * answer) is handled by applyCastStatus() calling
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
   * it actually starts sound turns on runtime.restoredWasPlaying (the
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
      if (runtime.restoredWasPlaying) {
        this.startLocalRadio(this.radioStation.streamUrl)
        this.isPlaying = true
      }
      return
    }
    const song = this.currentSong
    if (!song) return
    this.startLocalSong(song, this.localPosition, runtime.restoredWasPlaying)
    if (runtime.restoredWasPlaying) this.isPlaying = true
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
    // Before the session goes: connect would otherwise keep rendering
    // this tab's mix for nobody, under the old account.
    getLocalMix().stop()
    getAudioEngine().stop()
    useDrawersStore().resetDrawers()
    autoplayExhaustedSeedIds.clear() // module-level, so $reset() below doesn't reach it
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
}
