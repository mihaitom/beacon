import { defineStore } from 'pinia'
import { getAudioEngine } from '@/services/audioEngine'
import { calculateReplayGain, type ReplayGainMode } from '@/services/replayGain'
import { useLibraryStore } from './library'
import { useConnectStore } from './connect'
import * as connectPlayback from '@/services/connect/playback'
import type { ConnectDeviceRef, ConnectStatus } from '@/services/connect/types'
import type { Artist, RadioStation, Song } from '@/types/library'

type RepeatMode = 'off' | 'all' | 'one'

interface PlaybackState {
  originalQueue: Song[]
  queue: Song[]
  currentIndex: number
  isPlaying: boolean
  localPosition: number
  duration: number
  volume: number
  shuffle: boolean
  repeatMode: RepeatMode
  replayGainMode: ReplayGainMode
  radioStation: RadioStation | null
  initialized: boolean
  queueDrawerOpen: boolean
  lyricsDrawerOpen: boolean
}

// Scrubbing backwards restarts the current song instead of jumping to the
// previous one once you're more than this far in — matches how every other
// music player's "previous" button behaves.
const RESTART_THRESHOLD_SECONDS = 3

// Edge-detects status.ended's false→true transition across SSE updates
// (module-level: the SSE subscription in init() is set up once per app
// lifetime, not per store-consumer, so this doesn't belong in state).
let lastEnded = false

// Guards reconcileFromStatus()'s getSong() lookup against firing again for
// every ~2s SSE tick while the fetch for the same song is still in flight.
let reconcilingSongId: string | null = null

// Bumped at the top of every switchToIndex() call — lets its catch block
// tell whether it's still the *latest* switch attempt before rolling
// currentIndex back on failure. Without this, a slow-to-fail older call
// (e.g. the first of two rapid Next clicks) can resolve its catch after a
// second, successful switchToIndex() has already moved currentIndex on,
// stomping it back to the wrong song. Module-level for the same reason as
// lastEnded above — this needs to survive across calls, not live in
// per-invocation local state.
let switchToIndexSeq = 0

// Bumped at the top of every startCurrent() call — lets its own tail (the
// isPlaying=true flip and "now playing" scrobble) tell whether a newer
// startCurrent() has since superseded it before applying those, the same
// class of race switchToIndexSeq guards against above. Kept separate from
// switchToIndexSeq since startCurrent() also runs outside switchToIndex()
// (playSongList(), advanceOnSongEnd()'s repeat-one branch).
let startCurrentSeq = 0

// Set while our own startCurrent() has told the connect backend to switch
// to a song but hasn't heard back yet — an SSE status tick can land in
// that gap still reporting the *previous* song (the backend hasn't
// processed our command yet), which reconcileFromStatus() would otherwise
// read as "a queue it doesn't recognize" and blow away the whole queue down
// to that one stale song. See reconcileFromStatus()'s early return below.
let pendingLocalSongChange: string | null = null

// The song id already registered as "played" (scrobble submission=true)
// during the current play-through — guards checkScrobbleThreshold() against
// submitting more than once per play, and naturally allows a re-scrobble
// when the same song is played again later (a fresh startCurrent() resets
// this to null first, see below).
let scrobbledSongId: string | null = null

// Cast playback's position otherwise only ever moves in ~2s jumps (however
// often the connect backend's SSE status ticks — see connect.$subscribe()
// below), which reads as visibly stuttering on the seek bar and puts lyric
// line highlighting up to ~2s behind the actual audio. These two song the
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
let wasCastingActive = false

// All the singleton bookkeeping above (lastEnded, the seq counters,
// persistTimer, ...) lives outside Pinia's own reactive state, so Vite's
// partial HMR doesn't know to reset or preserve it consistently — a live
// edit to this file while a song's playing can leave a *new* module
// instance's fresh `lastEnded = false` etc. racing against timers/
// subscriptions still running from the *old* one, which reads as
// impossible playback bugs (UI stuck on a track connect already advanced
// past, see the 2026-08-18 "stuck on Tinlicker" debugging session).
// hot.decline() used to be the direct way to opt a module out of HMR, but
// Vite removed it — self-accepting and immediately invalidating is the
// current replacement, forcing a full reload on any edit to this file
// instead of a partial hot-swap. Slower, but guarantees a clean,
// single-instance start every time.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot!.invalidate('stores/playback.ts holds singleton state that cannot be safely hot-reloaded')
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
    // 'off' by default — ReplayGain changes playback volume, which
    // shouldn't happen for existing users without them opting in first.
    replayGainMode: 'off',
    radioStation: null,
    initialized: false,
    queueDrawerOpen: false,
    lyricsDrawerOpen: false,
  }),

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
    /** Song ids after `currentSong`, for connectPlayback.play()'s `queue`
     * option — lets connect auto-advance casting on its own instead of
     * needing this renderer awake for every single song (see
     * services/connect/playback.ts's own comment). Empty under repeat-one:
     * connect would otherwise auto-advance straight past the very song the
     * user asked to loop, which only this renderer's own repeat-mode logic
     * (advanceOnSongEnd() below) knows to keep replaying instead. Repeat-
     * all's wraparound past the end of this list is a similar renderer-only
     * case, left alone here — see this store's own advanceOnSongEnd(). */
    upcomingQueueIds(state): string[] {
      if (state.repeatMode === 'one') return []
      return state.queue.slice(state.currentIndex + 1).map((t) => t.id)
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
          // A takeover displacing this session from its target is not the
          // user asking to stop — picking playback back up over local
          // speakers would be audibly wrong (nobody asked this machine to
          // start making sound). Just go quiet instead; see ConnectStatus.
          // displaced's comment and displace_target() in session.py.
          if (status?.displaced) this.isPlaying = false
          else void this.handOffToLocalPlayback()
        }
        wasCastingActive = activeNow

        if (!status || !activeNow) return

        this.isPlaying = status.streaming && !status.paused
        this.localPosition = status.elapsed
        lastServerElapsed = status.elapsed
        lastServerElapsedAt = performance.now()
        if (status.current_song) this.duration = status.current_song.duration
        this.checkScrobbleThreshold()

        void this.reconcileFromStatus(status)

        if (status.ended && !lastEnded) void this.advanceOnSongEnd()
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
      const url = useLibraryStore().client().streamUrl(song.id)
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
      if (this.radioStation) {
        if (this.isPlaying) getAudioEngine().play(this.radioStation.streamUrl)
        return
      }
      const song = this.currentSong
      if (!song) return
      const url = useLibraryStore().client().streamUrl(song.id)
      const gain = this.replayGainMultiplier
      if (this.isPlaying) {
        getAudioEngine().play(url, this.localPosition, gain)
      } else {
        getAudioEngine().load(url, this.localPosition, gain)
      }
    },

    /** Keeps currentIndex following the connect backend's reported
     * current_song whenever it's out of sync with local state — the common
     * case is connect auto-advancing its own queue (see the top-level
     * Casting-Autoadvance design), where the song is already somewhere in
     * `this.queue` and this just needs to move the pointer. Falls back to
     * fetching and adopting a single-song queue only when the reported song
     * isn't in the known queue at all — right after a page reload (Pinia
     * state resets to empty, but the backend/cast device is still mid-song)
     * or a fresh SSE subscription discovering playback already in progress.
     * Without this, `currentSong` stays null forever even though something
     * is audibly playing, so the PlayerBar and the "now playing" row
     * highlight both go blank. A no-op once local state already matches. */
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

      const remote = status.current_song
      if (!remote) return
      if (this.currentSong?.id === remote.id) return
      if (pendingLocalSongChange) return // our own song switch hasn't been confirmed yet — see above

      // The common case: connect auto-advanced within a queue the renderer
      // already has in full (see the top-level Casting-Autoadvance design —
      // connect keeps playing through its own queue independently of
      // whether this renderer is even awake). Just follow the pointer to
      // where that song already lives instead of falling through to the
      // fetch-and-replace path below, which used to blow away the entire
      // known queue down to this one song on *every single* advance.
      const existingIndex = this.queue.findIndex((song) => song.id === remote.id)
      if (existingIndex !== -1) {
        this.currentIndex = existingIndex
        return
      }

      if (reconcilingSongId === remote.id) return // fetch already in flight

      reconcilingSongId = remote.id
      try {
        const song = await useLibraryStore().client().getSong(remote.id)
        // Re-check after the await — the real thing (a user action, another
        // SSE tick resolving first) may have already moved state on.
        if (this.currentSong?.id !== song.id) {
          this.radioStation = null
          this.originalQueue = [song]
          this.queue = [song]
          this.currentIndex = 0
        }
      } catch (error) {
        console.error('[playback] Failed to reconcile current song from status:', error)
      } finally {
        if (reconcilingSongId === remote.id) reconcilingSongId = null
      }
    },

    /** Sets up queue + currentIndex only — no playback side effect. */
    setQueue(songs: Song[], startIndex = 0): void {
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
        this.queue = shuffledExcept(songs, songs[startIndex])
        this.currentIndex = this.queue.findIndex((t) => t.id === songs[startIndex]?.id)
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
     * UI pointing at a song that never actually started playing. */
    async switchToIndex(index: number): Promise<void> {
      const previous = this.currentIndex
      this.currentIndex = index
      const seq = ++switchToIndexSeq
      try {
        await this.startCurrent()
      } catch (error) {
        // Only roll back if nothing newer (another switchToIndex call) has
        // already taken over — otherwise this stale failure would stomp
        // currentIndex back over a since-successful switch. See
        // switchToIndexSeq's comment.
        if (seq === switchToIndexSeq) {
          this.currentIndex = previous
          this.isPlaying = false
        }
        console.error('[playback] Failed to switch songs:', error)
      }
    },

    async playSongList(songs: Song[], startIndex = 0): Promise<void> {
      this.setQueue(songs, startIndex)
      await this.startCurrent()
    },

    /** Song Radio — fetches songs similar to `song` from the media server
     * and starts a fresh queue with `song` first, so picking it always
     * plays the song you actually clicked, not an arbitrary similar one. */
    async startSongRadio(song: Song): Promise<void> {
      const similar = await useLibraryStore().client().getSimilarSongs2(song.id)
      const songs = [song, ...similar.filter((t) => t.id !== song.id)]
      await this.playSongList(songs, 0)
    },

    /** Artist Radio — same getSimilarSongs2 endpoint as Song Radio, but
     * `id` here is the artist's own id rather than a song's; Navidrome's
     * recommendation engine accepts either (see SubsonicClient.
     * getSimilarSongs2's docstring). No single "seed" song to pin first
     * like Song Radio does — the whole point here is a mix across the
     * artist's catalog, not one particular song. */
    async startArtistRadio(artist: Artist): Promise<void> {
      const songs = await useLibraryStore().client().getSimilarSongs2(artist.id)
      await this.playSongList(songs, 0)
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
      const song = this.currentSong
      if (!song) return
      const seq = ++startCurrentSeq
      const connect = useConnectStore()
      this.localPosition = startPosition
      scrobbledSongId = null // fresh play-through, even if it's the same song id as before
      // Otherwise the extrapolation interval (see lastServerElapsed's
      // comment above) would keep advancing *this* song's position from
      // the *previous* song's last known elapsed until the next real SSE
      // tick corrects it — a stale number that looks like live progress,
      // worse than just sitting still. Cleared here regardless of cast
      // state; harmless when not casting since the interval already no-ops
      // then.
      lastServerElapsed = null

      if (connect.isActive) {
        pendingLocalSongChange = song.id
        try {
          await connectPlayback.play(song.id, {
            targets: connect.activeTargets,
            startPosition,
            gain: this.replayGainMultiplier,
            queue: this.upcomingQueueIds,
          })
        } finally {
          if (pendingLocalSongChange === song.id) pendingLocalSongChange = null
        }
      } else {
        const url = useLibraryStore().client().streamUrl(song.id)
        getAudioEngine().play(url, startPosition, this.replayGainMultiplier)
      }
      // A newer startCurrent() already took over while the above awaited —
      // applying isPlaying/scrobble here would be reporting "now playing"
      // for a song that isn't the current one anymore. See
      // startCurrentSeq's comment.
      if (seq !== startCurrentSeq) return
      this.isPlaying = true
      void useLibraryStore()
        .client()
        .scrobble(song.id, false)
        .catch((error) => console.error('[scrobble] now-playing failed:', error))
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
      await this.switchToIndex(index)
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
        await this.switchToIndex(this.currentIndex)
        return
      }
      // nextIndex(-1) returning null means "no previous" (start of a
      // non-repeating queue) — restart the current song instead, same as
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
      // upcomingQueueIds is [] under repeat-one (see its own comment) —
      // switching into or out of that mode changes what connect should be
      // auto-advancing through even though this.queue itself didn't change.
      this.syncCastQueue()
    },

    addToQueue(songs: Song[]): void {
      const toAdd = dedupeForQueue(songs, this.queue)
      this.originalQueue.push(...toAdd)
      this.queue.push(...toAdd)
      this.syncCastQueue()
    },

    /** Inserts `songs` right after the currently playing one — "Play next",
     * as opposed to addToQueue() which appends at the end. */
    queueNext(songs: Song[]): void {
      if (this.currentIndex < 0) {
        this.addToQueue(songs)
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

    /** Pushes the upcoming queue to the connect backend whenever it's
     * casting — otherwise connect's own auto-advance (_advance_or_end() in
     * routes/stream.py, see AppState.queue's comment and
     * services/connect/playback.ts's `queue` option) keeps stepping through
     * whichever queue was last sent at startCurrent() time, ignoring any
     * reorder/add/remove/shuffle made on the renderer since — invisible
     * right up until connect auto-advances on its own to the wrong song
     * (e.g. the controlling phone's screen locks before a manual skip would
     * have caught it). No-op once nothing's actually playing yet
     * (currentIndex < 0) — startCurrent() sends the initial queue itself. */
    syncCastQueue(): void {
      if (!this.isCasting || this.currentIndex < 0) return
      void connectPlayback.updateQueue(this.upcomingQueueIds).catch((error) => {
        console.error('[playback] Failed to sync queue to connect:', error)
      })
    },

    /** Drops everything from the queue except whatever's currently playing
     * — same "can't remove what's playing" rule removeFromQueue() already
     * enforces per-row, just applied to the whole queue at once. Radio has
     * no queue to clear (this.queue is already empty then; QueueDrawer.vue
     * only shows the button at all once there's more than the current
     * song to drop, see its own guard). */
    clearQueue(): void {
      const current = this.currentSong
      if (!current) {
        this.originalQueue = []
        this.queue = []
        this.currentIndex = -1
        return
      }
      this.originalQueue = [current]
      this.queue = [current]
      this.currentIndex = 0
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
      this.$reset()
    },

    toggleQueueDrawer(): void {
      this.queueDrawerOpen = !this.queueDrawerOpen
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
    async castTo(targets: ConnectDeviceRef[], force = false): Promise<void> {
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
          await connectPlayback.playUrl(station.streamUrl, station.name, { targets, force: f })
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
        const queue = this.upcomingQueueIds
        const play = async (f: boolean) => {
          if (this.isPlaying) getAudioEngine().pause() // local pauses, connect takes over
          await connectPlayback.play(song.id, { targets, startPosition, force: f, gain, queue })
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
function dedupeForQueue(songs: Song[], existingQueue: Song[]): Song[] {
  const seen = new Set<Song>(existingQueue)
  return songs.map((t) => {
    if (seen.has(t)) return { ...t }
    seen.add(t)
    return t
  })
}

function shuffledExcept(songs: Song[], keepFirst: Song | null | undefined): Song[] {
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
