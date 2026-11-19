/** This device's own player: a song on its own, or a mix of several. */
import { getAudioEngine } from '@/services/audioEngine'
import { mixQuality, plan, prefersHls } from '@/services/streamQuality'
import { useLibraryStore } from '../library'
import { useTransitionsStore } from '../transitions'
import type { Song } from '@/types/library'
import { getLocalMix, upcomingSongs } from '@/services/playback/localMix'
import { runtime } from './shared'
import type { PlaybackContext } from './context'

// Stream time at which the song this device's mix is playing began - see
// followLocalMix(). Null until the first song of a run has been heard.
let mixSongStartedAt: number | null = null

export interface LocalActions {
  prepareLocalPlayback(autoplay?: boolean): void
  localStreamUrl(song: Song, hls?: boolean): string
  startLocalSong(song: Song, position: number, autoplay: boolean): void
  localMixWanted(): boolean
  startLocalMix(song: Song, position: number, autoplay: boolean): Promise<void>
  followLocalMix(streamTime: number): void
  mixBufferedPosition(): number
  localMixSongBegan(songId: string, queueIndex: number): void
  syncLocalMixQueue(): void
  startLocalSongDirectly(song: Song, position: number, autoplay: boolean): void
}

export const localActions: LocalActions & ThisType<PlaybackContext> = {
  /** Makes this device's own player usable again once a cast has ended —
   * called from applyCastStatus(), and the live-session
   * counterpart to resumeLocalPlayback() at app boot.
   *
   * Loads, never plays, whoever ended the cast and however it ended. A
   * device that starts making sound nobody asked it for is wrong even
   * when it is the device the cast was started from: a shared session
   * means every client sees the cast end, so anything audible here
   * happens on all of them at once. Whatever was playing stays on the
   * player bar, paused, and pressing play carries it on. The exception is
   * `autoplay`, set only on the client whose "play here instead" ended
   * the cast (see playHere()).
   *
   * The loading is the point: the local element is not kept in sync while
   * casting (every song start goes to the backend instead, see
   * startCurrent()), and yieldToCastPlayback() dropped its src outright,
   * so without this play/pause afterwards would act on stale or empty
   * state. Positioned from this.localPosition, this session's own live
   * value, rather than resumeLocalPlayback()'s stored snapshot. */
  prepareLocalPlayback(autoplay = false): void {
    // Casting is over; there is nothing left to resume on a device.
    this.castInterrupted = false
    this.isPlaying = false
    if (this.radioStation) {
      // Casting is what radioBuffering describes (a cast target still
      // filling its own startup buffer — see SeekBar.vue's own comment);
      // local playback has no equivalent stall to report, and the SSE
      // handler that normally clears this on the way down (playback.ts's
      // own $subscribe) has already stopped running by the time this
      // runs (`!activeNow` short-circuits it first). Left stale, the
      // "Buffering…" indicator it drives would otherwise stick forever.
      this.radioBuffering = false
      this.radioConnectionLost = false
      // Nothing to preload for a station: a live stream has no position
      // to be loaded at, so pressing play is what opens the connection
      // (see togglePlay()'s own radio branch).
      if (autoplay) {
        this.startLocalRadio(this.radioStation.streamUrl)
        this.isPlaying = true
      }
      return
    }
    // A preview played on the speakers, which are gone: back to the
    // queue's song where the preview had interrupted it.
    if (this.preview) {
      this.localPosition = this.preview.resumeAt
      this.preview = null
    }
    const song = this.currentSong
    if (!song) return
    this.startLocalSong(song, this.localPosition, autoplay)
  },

  /** The stream URL for `song`, recording what was actually decided.
   * The two belong together: the stream-info panel describes what is
   * playing by reading `activeLocalStream`, and a URL built anywhere
   * else would leave that describing the previous track.
   *
   * Note this is not simply the setting — plan() applies it as a
   * ceiling, so a track already below it is fetched untouched.
   *
   * `hls` is a parameter rather than asked here so that startLocalSong()
   * can decide it once and act on the same answer the URL was built
   * from — the engine has to be told which shape it is being handed. */
  localStreamUrl(song: Song, hls = prefersHls()): string {
    const streamPlan = plan(song, this.localQuality)
    this.activeLocalStream = streamPlan
    return useLibraryStore().client().streamUrl(song.id, streamPlan.quality, { hls })
  },

  /** Starts (or, with `autoplay: false`, only loads) `song` on the local
   * element at `position`.
   *
   * The one place that decides between the ways a local stream can
   * be positioned, so every caller gets the same answer:
   *
   * - The untouched file is served by the media server with a real
   *   length. The element seeks in it by itself, which is both correct
   *   and instant, and there is nothing to improve on.
   * - A transcode is produced on demand by connect, and asking the
   *   element to seek in it means declaring a length of
   *   `bitrate x duration` and hoping the encoder hits that bitrate
   *   exactly. Only mp3 does. So the seeking is done here instead: each
   *   position is a fresh request that starts there (see playFrom() and
   *   routes/local_stream.py's `start`), and the format is free to be
   *   whatever sounds best per bit.
   * - The same transcode as HLS (WebKit only, see prefersHls()) is a
   *   playlist of the whole track, so it is played like the file: the
   *   element seeks in it, and its clock is the song's. That clock is
   *   what an iPhone's lock screen shows and scrubs, whatever position
   *   the page reports (see connect/core/hls.py). `start` only has
   *   connect start encoding where the element is about to seek to.
   *
   * A transcode costs nothing extra for this: a byte-range seek already
   * started a new ffmpeg at the requested second, so the same work
   * happens either way - it is only the arithmetic in between that goes
   * away. */
  startLocalSong(song: Song, position: number, autoplay: boolean): void {
    this.mixNextLocked = false
    this.mixTransitions = []
    if (this.localMixWanted()) {
      void this.startLocalMix(song, position, autoplay)
      return
    }
    getLocalMix().stop()
    this.startLocalSongDirectly(song, position, autoplay)
  },

  /** Whether this device plays through a mix (transitions on, see
   * services/playback/localMix.ts) rather than song by song - on WebKit
   * as a live HLS playlist. */
  localMixWanted(): boolean {
    return useTransitionsStore().enabled && !this.radioStation
  },

  /** Starts (or loads) this device's mix from `song` at `position` - the
   * transitions counterpart of startLocalSongDirectly(). Falls back to
   * playing the song on its own if connect cannot start one. */
  async startLocalMix(song: Song, position: number, autoplay: boolean): Promise<void> {
    const quality = mixQuality(this.localQuality)
    this.activeLocalStream = { quality, reason: 'transitions' }
    this.duration = song.duration
    // The previous run's lock is not this one's: until its first
    // timeupdate the new song would otherwise inherit it.
    this.mixNextLocked = false
    this.mixTransitions = []
    try {
      const started = await getLocalMix().start({
        songs: upcomingSongs(this.queue, this.currentIndex, this.repeatMode, this.replayGainMode),
        position,
        repeatMode: this.repeatMode,
        transitions: useTransitionsStore().payload,
        quality,
        autoplay,
      })
      // Only once the new run is adopted: the old element's timeupdates
      // keep arriving while connect answers, and a reset before then
      // would let one of them seed the old run's song as this one's.
      if (started) mixSongStartedAt = null
    } catch (error) {
      console.error('[playback] Could not start the mix, playing the song on its own:', error)
      getLocalMix().stop()
      this.startLocalSongDirectly(song, position, autoplay)
    }
  },

  /** Moves this device along with its mix: `streamTime` is how far into
   * the mix the element is, and the timeline says which song and where
   * in it that is. A song that begins is taken up the way startCurrent()
   * takes up one it starts, minus the starting. */
  followLocalMix(streamTime: number): void {
    if (getLocalMix().starting) return
    const heard = getLocalMix().heard(streamTime)
    if (!heard) return
    if (this.preview) {
      // Nothing of the queue moves: no index, no scrobble, no Autoplay.
      if (heard.queueIndex !== this.preview.index) {
        this.preview.index = heard.queueIndex
        this.duration = this.currentSong?.duration ?? 0
      }
      this.localPosition = heard.position
      this.bufferedPosition = this.mixBufferedPosition()
      return
    }
    if (heard.startedAt !== mixSongStartedAt) {
      const first = mixSongStartedAt === null
      mixSongStartedAt = heard.startedAt
      if (!first) this.localMixSongBegan(heard.songId, heard.queueIndex)
    }
    this.localPosition = heard.position
    this.bufferedPosition = this.mixBufferedPosition()
    this.mixNextLocked = getLocalMix().nextLocked
    this.mixTransitions = getLocalMix().transitions
  },

  /** The mix's buffered end as seconds into the current song - stream
   * time is not song time, least of all after a seek, which starts the
   * stream over at 0 mid-song. */
  mixBufferedPosition(): number {
    return Math.min(
      this.duration,
      getLocalMix().loadedThrough(runtime.mixBufferedEnd) ?? this.duration,
    )
  },

  localMixSongBegan(songId: string, queueIndex: number): void {
    const index =
      this.queue[queueIndex]?.id === songId
        ? queueIndex
        : this.queue.findIndex((song) => song.id === songId)
    if (index < 0) return
    this.currentIndex = index
    const song = this.queue[index]!
    this.duration = song.duration
    runtime.scrobbledSongId = null
    void useLibraryStore()
      .client()
      .scrobble(song.id, false)
      .catch((error) => console.error('[scrobble] now-playing failed:', error))
    void this.maybeAutoplay()
    this.syncLocalMixQueue()
  },

  /** Tells this device's mix which songs come next - the local
   * counterpart of syncCastQueue(), and called from it. */
  syncLocalMixQueue(): void {
    const mix = getLocalMix()
    if (!mix.active) return
    mix.syncQueue(
      upcomingSongs(this.queue, this.currentIndex, this.repeatMode, this.replayGainMode),
      this.repeatMode,
    )
  },

  /** startLocalSong() without transitions: one song on the element, as
   * Beacon always played. */
  startLocalSongDirectly(song: Song, position: number, autoplay: boolean): void {
    const hls = prefersHls()
    const url = this.localStreamUrl(song, hls)
    const gain = this.replayGainMultiplier
    const engine = getAudioEngine()
    if (this.activeLocalStream?.quality.format === 'original') {
      if (autoplay) engine.play(url, position, gain)
      else engine.load(url, position, gain)
      return
    }
    if (hls) {
      const src = `${url}&start=${Math.max(0, position).toFixed(3)}`
      if (autoplay) engine.play(src, position, gain, { hls })
      else engine.load(src, position, gain, { hls })
      return
    }
    // `start` on every request, including the one for the beginning: its
    // presence is what tells connect not to declare a length (see the
    // route's docstring), and a first request without it would hand the
    // element a length to seek against for as long as the track played
    // from the top.
    const urlFor = (seconds: number): string => `${url}&start=${Math.max(0, seconds).toFixed(3)}`
    // A transcoded stream declares no length, so the element never
    // reports the track's duration. The library already knows how long the
    // track is — and the engine needs the same number for a second
    // reason: without it, a stream cut off mid-track is indistinguishable
    // from one that finished, and the next song starts instead of the
    // connection being picked back up (see playFrom()).
    const duration = song.duration ?? 0
    if (autoplay) engine.playFrom(urlFor, position, gain, duration || null)
    else engine.loadFrom(urlFor, position, gain, duration || null)
    this.duration = duration
  },
}
