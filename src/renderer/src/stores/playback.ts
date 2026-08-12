import { defineStore } from 'pinia'
import { getAudioEngine } from '@/services/audioEngine'
import { useLibraryStore } from './library'
import { useConnectStore } from './connect'
import * as connectPlayback from '@/services/connect/playback'
import type { ConnectDeviceRef, ConnectStatus } from '@/services/connect/types'
import type { RadioStation, Track } from '@/types/library'

type RepeatMode = 'off' | 'all' | 'one'

interface PlaybackState {
  originalQueue: Track[]
  queue: Track[]
  currentIndex: number
  isPlaying: boolean
  localPosition: number
  duration: number
  volume: number
  shuffle: boolean
  repeatMode: RepeatMode
  radioStation: RadioStation | null
  initialized: boolean
  queueDrawerOpen: boolean
  lyricsDrawerOpen: boolean
}

// Scrubbing backwards restarts the current track instead of jumping to the
// previous one once you're more than this far in — matches how every other
// music player's "previous" button behaves.
const RESTART_THRESHOLD_SECONDS = 3

// Edge-detects status.ended's false→true transition across SSE updates
// (module-level: the SSE subscription in init() is set up once per app
// lifetime, not per store-consumer, so this doesn't belong in state).
let lastEnded = false

// Guards reconcileFromStatus()'s getSong() lookup against firing again for
// every ~2s SSE tick while the fetch for the same track is still in flight.
let reconcilingTrackId: string | null = null

// Set while our own startCurrent() has told the connect backend to switch
// to a track but hasn't heard back yet — an SSE status tick can land in
// that gap still reporting the *previous* track (the backend hasn't
// processed our command yet), which reconcileFromStatus() would otherwise
// read as "a queue it doesn't recognize" and blow away the whole queue down
// to that one stale track. See reconcileFromStatus()'s early return below.
let pendingLocalTrackChange: string | null = null

// The track id already registered as "played" (scrobble submission=true)
// during the current play-through — guards checkScrobbleThreshold() against
// submitting more than once per play, and naturally allows a re-scrobble
// when the same track is played again later (a fresh startCurrent() resets
// this to null first, see below).
let scrobbledTrackId: string | null = null

// Cast playback's position otherwise only ever moves in ~2s jumps (however
// often the connect backend's SSE status ticks — see connect.$subscribe()
// below), which reads as visibly stuttering on the seek bar and puts lyric
// line highlighting up to ~2s behind the actual audio. These two track the
// last real (server-authoritative, buffering-delay-calibrated — see
// connect/routes/playback.py's _apply_position_offset) position report, so
// the interval below can extrapolate smoothly forward from it every 200ms
// in between, re-anchoring to the next real report as soon as it arrives
// (small corrections, not visible jumps, the same way any client-side
// clock reconciled against a server clock behaves). `null` until the first
// real report — extrapolating before that would just be guessing.
let lastServerElapsed: number | null = null
let lastServerElapsedAt = 0

// Subsonic/Last.fm convention: a play counts once listened past 50% of the
// track or 4 minutes, whichever comes first.
const SCROBBLE_PERCENT = 0.5
const SCROBBLE_MAX_SECONDS = 240

// localStorage key for the persisted queue/position snapshot (see init()'s
// $subscribe and restoreFromStorage()) — lets a reload (or app restart)
// pick local playback back up close to where it left off, since a reload
// necessarily destroys the <audio> element and stops it for a moment.
const PERSIST_KEY = 'beacon.playback'

interface PersistedPlaybackState {
  queue: Track[]
  originalQueue: Track[]
  currentIndex: number
  radioStation: RadioStation | null
  shuffle: boolean
  repeatMode: RepeatMode
  volume: number
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
let wasCastingActive = false

/**
 * Casting is a built-in playback target here, not an external interception
 * layer — every action below checks `useConnectStore().isActive` itself and
 * either drives the shared AudioEngine (local) or the connect backend
 * (cast). Callers (views/components) always call this store directly and
 * never need to know which one is actually happening.
 */
export const usePlaybackStore = defineStore('playback', {
  state: (): PlaybackState => ({
    originalQueue: [],
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    localPosition: 0,
    duration: 0,
    volume: 1,
    shuffle: false,
    repeatMode: 'off',
    radioStation: null,
    initialized: false,
    queueDrawerOpen: false,
    lyricsDrawerOpen: false,
  }),

  getters: {
    currentTrack(state): Track | null {
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
  },

  actions: {
    /** Wires the shared AudioEngine for local playback, restores the last
     * session's queue/position (see restoreFromStorage()), and subscribes
     * to connect SSE status to mirror cast playback state + auto-advance
     * the queue on track-end. Call once (App.vue). */
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
        if (!this.isCasting) void this.advanceOnTrackEnd()
      }
      engine.onError = (message) => {
        console.error('[playback]', message)
        this.isPlaying = false
      }

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
        if (localResumeDecided && wasCastingActive && !activeNow) {
          void this.handOffToLocalPlayback()
        }
        wasCastingActive = activeNow

        if (!status || !activeNow) return

        this.isPlaying = status.streaming && !status.paused
        this.localPosition = status.elapsed
        lastServerElapsed = status.elapsed
        lastServerElapsedAt = performance.now()
        if (status.current_track) this.duration = status.current_track.duration
        this.checkScrobbleThreshold()

        void this.reconcileFromStatus(status)

        if (status.ended && !lastEnded) void this.advanceOnTrackEnd()
        lastEnded = status.ended
      })

      // Smooths the ~2s-stepped position above into something that moves
      // every 200ms instead — see lastServerElapsed's comment. A no-op
      // whenever not actively cast-playing, so this is cheap to just leave
      // running for the app's whole lifetime rather than starting/stopping
      // it around every play/pause/cast-toggle.
      setInterval(() => {
        if (!this.isCasting || !this.isPlaying || lastServerElapsed === null) return
        const extrapolated = lastServerElapsed + (performance.now() - lastServerElapsedAt) / 1000
        this.localPosition = this.duration ? Math.min(extrapolated, this.duration) : extrapolated
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

    /** Called once auth is confirmed (App.vue's watcher, right where it
     * also subscribes to connect SSE) — starts a short fallback timer for
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
     * the reload; otherwise just loads the track/position so hitting play
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
      const track = this.currentTrack
      if (!track) return
      const url = useLibraryStore().client().streamUrl(track.id)
      if (restoredWasPlaying) {
        getAudioEngine().play(url, this.localPosition)
        this.isPlaying = true
      } else {
        getAudioEngine().load(url, this.localPosition)
      }
    },

    /** The live-session counterpart to resumeLocalPlayback() — called when
     * a cast session ends mid-session (see init()'s connect $subscribe
     * handler) instead of at app boot. The local <audio> element is never
     * kept in sync while casting (every track start/advance goes to the
     * connect backend instead — see startCurrent()/switchToIndex()), so
     * without this it's left pointing at stale or empty state once casting
     * stops, and play/pause afterwards does nothing or plays the wrong
     * track. Picks up from this.isPlaying/this.localPosition (this
     * session's own live values) rather than resumeLocalPlayback()'s
     * restored-from-storage snapshot. */
    async handOffToLocalPlayback(): Promise<void> {
      if (this.radioStation) {
        if (this.isPlaying) getAudioEngine().play(this.radioStation.streamUrl)
        return
      }
      const track = this.currentTrack
      if (!track) return
      const url = useLibraryStore().client().streamUrl(track.id)
      if (this.isPlaying) {
        getAudioEngine().play(url, this.localPosition)
      } else {
        getAudioEngine().load(url, this.localPosition)
      }
    },

    /** Rebuilds local queue/radioStation from the connect backend's status
     * when they're out of sync with what it reports playing — the normal
     * case right after a page reload (Pinia state resets to empty, but the
     * backend/cast device is still mid-track) or a fresh SSE subscription
     * discovering playback already in progress. Without this,
     * `currentTrack` stays null forever even though something is audibly
     * playing, so the PlayerBar and the "now playing" row highlight both
     * go blank. A no-op once local state already matches. */
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

      const remote = status.current_track
      if (!remote) return
      if (this.currentTrack?.id === remote.id) return
      if (pendingLocalTrackChange) return // our own track switch hasn't been confirmed yet — see above
      if (reconcilingTrackId === remote.id) return // fetch already in flight

      reconcilingTrackId = remote.id
      try {
        const track = await useLibraryStore().client().getSong(remote.id)
        // Re-check after the await — the real thing (a user action, another
        // SSE tick resolving first) may have already moved state on.
        if (this.currentTrack?.id !== track.id) {
          this.radioStation = null
          this.originalQueue = [track]
          this.queue = [track]
          this.currentIndex = 0
        }
      } catch (error) {
        console.error('[playback] Failed to reconcile current track from status:', error)
      } finally {
        if (reconcilingTrackId === remote.id) reconcilingTrackId = null
      }
    },

    /** Sets up queue + currentIndex only — no playback side effect. */
    setQueue(tracks: Track[], startIndex = 0): void {
      this.radioStation = null
      this.originalQueue = [...tracks]
      this.queue = this.shuffle ? shuffledExcept(tracks, tracks[startIndex]) : [...tracks]
      this.currentIndex = this.queue.findIndex((t) => t.id === tracks[startIndex]?.id)
    },

    /** Index math only (repeat-mode aware), no state mutation — returns the
     * index playNext()/playPrevious() should switch to, or null if there's
     * nowhere to go. Deliberately doesn't touch currentIndex itself: it used
     * to, but that let the UI (queue highlight, PlayerBar) jump to the next
     * track before the connect dispatch that's supposed to actually start it
     * had even resolved. If that dispatch then failed (device briefly
     * unreachable, claim race, ...), nothing rolled the index back — Beacon
     * kept showing "now playing" whatever track it had optimistically
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
     * UI pointing at a track that never actually started playing. */
    async switchToIndex(index: number): Promise<void> {
      const previous = this.currentIndex
      this.currentIndex = index
      try {
        await this.startCurrent()
      } catch (error) {
        this.currentIndex = previous
        this.isPlaying = false
        console.error('[playback] Failed to switch tracks:', error)
      }
    },

    async playTrackList(tracks: Track[], startIndex = 0): Promise<void> {
      this.setQueue(tracks, startIndex)
      await this.startCurrent()
    },

    /** Track Radio — fetches songs similar to `track` from the media server
     * and starts a fresh queue with `track` first, so picking it always
     * plays the track you actually clicked, not an arbitrary similar one. */
    async startTrackRadio(track: Track): Promise<void> {
      const similar = await useLibraryStore().client().getSimilarSongs2(track.id)
      const tracks = [track, ...similar.filter((t) => t.id !== track.id)]
      await this.playTrackList(tracks, 0)
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

    async startCurrent(startPosition = 0): Promise<void> {
      const track = this.currentTrack
      if (!track) return
      const connect = useConnectStore()
      this.localPosition = startPosition
      scrobbledTrackId = null // fresh play-through, even if it's the same track id as before
      // Otherwise the extrapolation interval (see lastServerElapsed's
      // comment above) would keep advancing *this* track's position from
      // the *previous* track's last known elapsed until the next real SSE
      // tick corrects it — a stale number that looks like live progress,
      // worse than just sitting still. Cleared here regardless of cast
      // state; harmless when not casting since the interval already no-ops
      // then.
      lastServerElapsed = null

      if (connect.isActive) {
        pendingLocalTrackChange = track.id
        try {
          await connectPlayback.play(track.id, { targets: connect.activeTargets, startPosition })
        } finally {
          if (pendingLocalTrackChange === track.id) pendingLocalTrackChange = null
        }
      } else {
        const url = useLibraryStore().client().streamUrl(track.id)
        getAudioEngine().play(url, startPosition)
      }
      this.isPlaying = true
      void useLibraryStore()
        .client()
        .scrobble(track.id, false)
        .catch((error) => console.error('[scrobble] now-playing failed:', error))
    },

    /** Registers the current track as "played" with the media server once
     * enough of it has actually been listened to — this is what drives
     * Navidrome's "recently played"/"frequent" album shelves and song play
     * counts. Called on every position update (local and cast), cheap no-op
     * once already submitted for this play-through (see scrobbledTrackId). */
    checkScrobbleThreshold(): void {
      const track = this.currentTrack
      if (!track || this.radioStation || scrobbledTrackId === track.id) return
      const duration = this.duration || track.duration
      if (!duration) return
      const threshold = Math.min(duration * SCROBBLE_PERCENT, SCROBBLE_MAX_SECONDS)
      if (this.localPosition < threshold) return
      scrobbledTrackId = track.id
      void useLibraryStore()
        .client()
        .scrobble(track.id, true)
        .catch((error) => console.error('[scrobble] submission failed:', error))
    },

    async togglePlay(): Promise<void> {
      const connect = useConnectStore()
      if (connect.isActive) {
        if (this.isPlaying) await connectPlayback.pause()
        else await connectPlayback.resume()
        return
      }
      const engine = getAudioEngine()
      if (this.isPlaying) {
        engine.pause()
        this.isPlaying = false
      } else {
        engine.resume()
        this.isPlaying = true
      }
    },

    /** Manual "skip forward" (PlayerBar's Next button) — always advances to
     * the next track, even with repeat-one active. Repeat-one only replays
     * the current track when it ends naturally, see advanceOnTrackEnd();
     * a manual skip is an explicit "I'm done with this one", same as every
     * other player. */
    async playNext(): Promise<void> {
      if (this.radioStation) return // radio has no queue to advance
      const index = this.nextIndex(1)
      if (index === null) {
        this.isPlaying = false
        return
      }
      await this.switchToIndex(index)
    },

    /** Called when a track finishes on its own (local <audio> 'ended', or
     * the connect backend's status.ended transition) — unlike playNext(),
     * this is where repeat-one actually applies (replays the current track
     * instead of advancing). */
    async advanceOnTrackEnd(): Promise<void> {
      if (this.radioStation) return
      if (this.repeatMode === 'one') {
        try {
          await this.startCurrent()
        } catch (error) {
          this.isPlaying = false
          console.error('[playback] Failed to replay track:', error)
        }
        return
      }
      await this.playNext()
    },

    async playPrevious(): Promise<void> {
      if (this.radioStation) return
      if (this.localPosition > RESTART_THRESHOLD_SECONDS) {
        await this.switchToIndex(this.currentIndex)
        return
      }
      // nextIndex(-1) returning null means "no previous" (start of a
      // non-repeating queue) — restart the current track instead, same as
      // hitting previous within RESTART_THRESHOLD_SECONDS above.
      await this.switchToIndex(this.nextIndex(-1) ?? this.currentIndex)
    },

    async playAtIndex(index: number): Promise<void> {
      if (index < 0 || index >= this.queue.length) return
      await this.switchToIndex(index)
    },

    async seek(position: number): Promise<void> {
      const connect = useConnectStore()
      if (connect.isActive) {
        await connectPlayback.seek(position)
        // Re-anchors the extrapolation interval (see lastServerElapsed's
        // comment) to the seeked-to position right away — otherwise it'd
        // keep extrapolating from the pre-seek anchor for up to ~200ms and
        // briefly overwrite this seek with a stale position.
        lastServerElapsed = position
        lastServerElapsedAt = performance.now()
      } else {
        getAudioEngine().seek(position)
      }
      this.localPosition = position
    },

    setVolume(volume: number): void {
      this.volume = volume
      getAudioEngine().setVolume(volume)
    },

    toggleShuffle(): void {
      this.shuffle = !this.shuffle
      const current = this.currentTrack
      this.queue = this.shuffle
        ? shuffledExcept(this.originalQueue, current)
        : [...this.originalQueue]
      if (current) {
        this.currentIndex = this.queue.findIndex((t) => t.id === current.id)
      }
    },

    cycleRepeatMode(): void {
      const order: RepeatMode[] = ['off', 'all', 'one']
      this.repeatMode = order[(order.indexOf(this.repeatMode) + 1) % order.length]!
    },

    addToQueue(tracks: Track[]): void {
      this.originalQueue.push(...tracks)
      this.queue.push(...tracks)
    },

    /** Inserts `tracks` right after the currently playing one — "Play next",
     * as opposed to addToQueue() which appends at the end. */
    queueNext(tracks: Track[]): void {
      if (this.currentIndex < 0) {
        this.addToQueue(tracks)
        return
      }
      this.queue.splice(this.currentIndex + 1, 0, ...tracks)
      const current = this.currentTrack
      const originalIndex = current ? this.originalQueue.findIndex((t) => t.id === current.id) : -1
      if (originalIndex >= 0) {
        this.originalQueue.splice(originalIndex + 1, 0, ...tracks)
      } else {
        this.originalQueue.push(...tracks)
      }
    },

    removeFromQueue(index: number): void {
      if (index === this.currentIndex) return // can't remove what's playing
      const [removed] = this.queue.splice(index, 1)
      if (index < this.currentIndex) this.currentIndex -= 1
      if (removed) {
        const originalIndex = this.originalQueue.findIndex((t) => t.id === removed.id)
        if (originalIndex >= 0) this.originalQueue.splice(originalIndex, 1)
      }
    },

    reorderQueue(from: number, to: number): void {
      const [moved] = this.queue.splice(from, 1)
      if (!moved) return
      this.queue.splice(to, 0, moved)
      if (from === this.currentIndex) this.currentIndex = to
      else if (from < this.currentIndex && to >= this.currentIndex) this.currentIndex -= 1
      else if (from > this.currentIndex && to <= this.currentIndex) this.currentIndex += 1
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

    /** Called from authStore.logout() — without this, the queue/currentTrack
     * from the account signing out stay in memory (this store is a
     * singleton for the app's whole lifetime, its init() only ever runs
     * once), so a different account logging in afterwards would see the
     * previous one's "now playing" and could try to stream a track id that
     * doesn't belong to them. Only stops local playback — leaves an active
     * cast target alone, since a physical speaker doesn't care which
     * account is signed into this window. */
    resetForLogout(): void {
      getAudioEngine().stop()
      this.$reset()
    },

    toggleQueueDrawer(): void {
      this.queueDrawerOpen = !this.queueDrawerOpen
    },

    toggleLyricsDrawer(): void {
      this.lyricsDrawerOpen = !this.lyricsDrawerOpen
    },

    /** Hands the currently loaded local track/radio off to the given cast
     * targets, or just claims them ahead of playback if nothing is loaded
     * yet — called by ConnectDevicePicker's "Connect"/"Add" action. Routed
     * through connect.withTakeoverHandling() (like claimDevices() already
     * is) so a device claimed by another session opens the takeover-confirm
     * dialog instead of the conflict just failing silently — unless `force`
     * is already true (the device-row "Take over" action decided that
     * up front), in which case there's nothing left to detect. */
    async castTo(targets: ConnectDeviceRef[], force = false): Promise<void> {
      const connect = useConnectStore()
      if (this.radioStation) {
        const station = this.radioStation
        const play = async (f: boolean) => {
          if (this.isPlaying) getAudioEngine().pause() // local pauses, connect takes over
          await connectPlayback.playUrl(station.streamUrl, station.name, { targets, force: f })
          this.isPlaying = true
        }
        if (force) await play(true)
        else await connect.withTakeoverHandling(play)
      } else if (this.currentTrack) {
        const track = this.currentTrack
        const startPosition = this.localPosition
        const play = async (f: boolean) => {
          if (this.isPlaying) getAudioEngine().pause() // local pauses, connect takes over
          await connectPlayback.play(track.id, { targets, startPosition, force: f })
          this.isPlaying = true
        }
        if (force) await play(true)
        else await connect.withTakeoverHandling(play)
      } else {
        await connect.claimDevices(targets)
      }
    },
  },
})

function shuffledExcept(tracks: Track[], keepFirst: Track | null | undefined): Track[] {
  const rest = tracks.filter((t) => t.id !== keepFirst?.id)
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j]!, rest[i]!]
  }
  return keepFirst ? [keepFirst, ...rest] : rest
}
