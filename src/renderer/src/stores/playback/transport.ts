/** Play, pause, skip, seek and stop - here or on the speakers. */
import { getAudioEngine } from '@/services/audioEngine'
import { prefersHls } from '@/services/streamQuality'
import { useLibraryStore } from '../library'
import { useConnectStore } from '../connect'
import { useEqualizerStore } from '../equalizer'
import { useDrawersStore } from '../drawers'
import { useRadioMetadataStore } from '../radioMetadata'
import * as connectPlayback from '@/services/connect/playback'
import { recordListen } from '@/services/connect/playHistory'
import type { PlayResponse } from '@/services/connect/types'
import type { Song } from '@/types/library'
import { createSequenceGuard } from '@/services/playback/sequenceGuard'
import { createLock } from '@/services/playback/lock'
import { getLocalMix, STALE_PAUSE_MS } from '@/services/playback/localMix'
import { stopRadioMetadataWatch } from '@/services/connect/radioMetadata'
import { localSongChangeGuard, positionTracker } from './shared'
import { runtime } from './shared'
import type { PlaybackContext } from './context'

// Pressing previous restarts the current song instead of jumping to the
// previous one once you're more than this far in — the usual behaviour for
// a music player's "previous" button. Raised from 3s (2026-08-28): a press
// this early almost always means "I meant the song before this one", and
// three seconds ran out before a reaction to a track change realistically
// lands, so the correction restarted the song it was trying to leave.
const RESTART_THRESHOLD_SECONDS = 5

// Guards switchToIndex()'s catch block against rolling currentIndex back
// once it's no longer the *latest* switch attempt. Without this, a
// slow-to-fail older call (e.g. the first of two rapid Next clicks) can
// resolve its catch after a second, successful switchToIndex() has already
// moved currentIndex on, stomping it back to the wrong song. Module-level
// for the same reason as lifecycle.ts's endedEdge — this needs to survive across
// calls, not live in per-invocation local state.
const switchToIndexGuard = createSequenceGuard()

// Guards togglePlay() against a second call landing while the connect
// branch's first one is still awaiting its pause()/resume() round trip —
// this.isPlaying isn't updated optimistically there (only the next SSE
// status tick does that, see applyCastStatus()), so a
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

// Recorded where every other device action records its failure (see the
// connect store's stopDevice()), which is what the device picker shows.
// Without it a pause or resume the speaker refused did nothing, silently.
async function recordDeviceFailure(
  connect: ReturnType<typeof useConnectStore>,
  action: Promise<void>,
): Promise<void> {
  try {
    await action
    connect.clearError()
  } catch (error) {
    connect.setError(error)
    throw error
  }
}

// Guards startCurrent()'s own tail (the isPlaying=true flip and "now
// playing" scrobble) against applying once a newer startCurrent() has since
// superseded it — the same class of race switchToIndexGuard guards against
// above. Kept separate from switchToIndexGuard since startCurrent() also
// runs outside switchToIndex() (playSongList(), advanceOnSongEnd()'s
// repeat-one branch).
const startCurrentGuard = createSequenceGuard()

// Subsonic/Last.fm convention: a play counts once listened past 50% of the
// song or 4 minutes, whichever comes first.
const SCROBBLE_PERCENT = 0.5

const SCROBBLE_MAX_SECONDS = 240

export interface TransportActions {
  switchToIndex(index: number, preservePause?: boolean): Promise<void>
  startCurrent(startPosition?: number): Promise<boolean>
  checkScrobbleThreshold(): void
  togglePlay(): Promise<void>
  playNext(): Promise<void>
  advanceOnSongEnd(): Promise<void>
  playPrevious(): Promise<void>
  playAtIndex(index: number): Promise<void>
  seek(position: number): Promise<void>
  setVolume(volume: number): void
  stop(): Promise<void>
  playSongList(
    songs: Song[],
    startIndex?: number,
    pinFirst?: boolean,
    peek?: boolean,
  ): Promise<void>
}

export const transportActions: TransportActions & ThisType<PlaybackContext> = {
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
        if (this.isCasting) {
          await connectPlayback.pause()
        } else {
          getAudioEngine().pause()
          getLocalMix().pause()
        }
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
    // Anything started replaces a preview, which only stood in for the
    // queue's song.
    this.preview = null
    const song = this.currentSong
    if (!song) return false
    const connect = useConnectStore()
    // A second start of the *same* song while the first /play is still in
    // flight is always a duplicate dispatch, never an intent: the first
    // one has not even reached the backend yet, so there is nothing to
    // restart. It comes from a double-click landing on a click-driven
    // control, or from two paths reaching this for one gesture.
    //
    // Worth stopping here rather than letting the backend sort it out,
    // because it cannot: both requests carry a newer seq than the last,
    // so both are accepted, and each one bumps the clock's
    // play_generation. The stream generator already feeding the device
    // keeps the *older* generation, plays the track to its end, and then
    // declines to report that end (routes/stream.py's _advance_or_end
    // guards on exactly that) — leaving playback stuck "playing" for
    // good. Reported live 2026-09-05, two /play 143ms apart; see
    // docs/investigations/streaming/track-end-never-reported.md.
    //
    // Ahead of everything below, startCurrentGuard included: a duplicate
    // that got as far as begin()ing that guard would invalidate the very
    // dispatch it is a duplicate of, which then reports "superseded" and
    // unwinds — the queue index included.
    if (connect.isActive && localSongChangeGuard.isCurrent(song.id)) return false
    const seq = startCurrentGuard.begin()
    this.localPosition = startPosition
    runtime.scrobbledSongId = null // fresh play-through, even if it's the same song id as before
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
          replayGainMode: this.replayGainMode,
          ...this.castQualityPayload,
          ...this.castMixPayload,
          equalizers: useEqualizerStore().castPayload,
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
    } else if (this.localMixWanted()) {
      // Awaited, unlike startLocalSong() below: the mix is started by
      // connect, and a caller pausing right after (switchToIndex()'s
      // preservePause) has to find it already loaded.
      await this.startLocalMix(song, startPosition, true)
    } else {
      this.startLocalSong(song, startPosition, true)
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
   * once already submitted for this play-through (see runtime.scrobbledSongId). */
  checkScrobbleThreshold(): void {
    const song = this.currentSong
    if (!song || this.radioStation || this.preview || runtime.scrobbledSongId === song.id) return
    const duration = this.duration || song.duration
    if (!duration) return
    const threshold = Math.min(duration * SCROBBLE_PERCENT, SCROBBLE_MAX_SECONDS)
    if (this.localPosition < threshold) return
    runtime.scrobbledSongId = song.id
    // Its own call, not chained to the scrobble: a media server that is
    // briefly away should not cost the listening year this play.
    recordListen(song).catch(() => {})
    void useLibraryStore()
      .client()
      .scrobble(song.id, true)
      .then(() => {
        // Optimistic, not re-fetched from the server — the count shown
        // anywhere this song is rendered (queue, song lists, Stats) and
        // Home's Rediscover shelf would otherwise stay stale until the
        // next catalogue refresh, even though the scrobble itself
        // genuinely succeeded server-side.
        useLibraryStore().notePlayed(song)
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
          await recordDeviceFailure(connect, connectPlayback.pause())
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
          await recordDeviceFailure(connect, connectPlayback.resume())
        }
        return
      }
      const engine = getAudioEngine()
      if (this.isPlaying) {
        engine.pause()
        getLocalMix().pause()
        this.isPlaying = false
      } else if (this.radioStation) {
        // resumeLocalPlayback() deliberately never loads radio into the
        // engine after a plain app restart (not runtime.restoredWasPlaying) — see
        // its own comment: there's no position to preload a live stream
        // to. engine.resume() below assumes something was already
        // loaded, which a track always is (resumeLocalPlayback() calls
        // load() unconditionally for one) but radio in that case is not
        // — resume() on an <audio> element with no src at all silently
        // did nothing. Radio has no "resume from where it paused" to
        // preserve either way, so restarting the live connection is the
        // same action whether something was loaded or not.
        //
        // Pressing play is also a reconnect, for a station whose
        // connection this device had already given up on —
        // startLocalRadio() clearing the flag is what stops
        // RadioLiveStatus.vue from still offering its own button over a
        // station that is audibly playing again.
        this.startLocalRadio(this.radioStation.streamUrl)
        this.isPlaying = true
      } else if (engine.hasEnded) {
        // The loaded track already played through to the end (e.g. the last
        // song of a non-repeating queue) — a bare resume() on an ended
        // <audio> element doesn't reliably restart it, so do a proper
        // restart instead, same as switchToIndex()/startCurrent() elsewhere.
        // Checked *after* the station branch above: the queue behind a
        // station is still loaded and can perfectly well be in its ended
        // state, and pressing play on a station has to restart the
        // station, not the track it interrupted.
        await this.startCurrent()
      } else if (engine.failed && this.preview) {
        await this.playPreviewAt(this.preview.index)
      } else if (engine.failed && this.currentSong) {
        // The stream was lost (the reconnects ran out, or an error nothing
        // retries): resuming the element plays nothing, so the source
        // starts over from where it was heard - a new run, for a mix.
        this.startLocalSong(this.currentSong, this.localPosition, true)
        this.isPlaying = true
      } else if (this.preview && getLocalMix().pausedFor() > STALE_PAUSE_MS) {
        await this.playPreviewAt(this.preview.index)
      } else if (getLocalMix().pausedFor() > STALE_PAUSE_MS && this.currentSong) {
        // See STALE_PAUSE_MS: a mix paused this long starts over from
        // where it stood rather than trusting connections idle as long.
        await this.startLocalMix(this.currentSong, this.localPosition, true)
        this.isPlaying = true
      } else {
        engine.resume()
        getLocalMix().resume()
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
    if (this.preview) {
      await this.previewNext()
      return
    }
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
    if (this.preview) {
      await this.playPreviewAt(Math.max(0, this.preview.index - 1))
      return
    }
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

  /** Picking a song straight out of the queue — which is also how you
   * leave a radio station, since the queue survives one now (see
   * playRadioStation()). The station has to go before switchToIndex()
   * below, not after: startCurrent() reads currentSong, and that stays
   * null for as long as a station is what's playing. */
  async playAtIndex(index: number): Promise<void> {
    if (index < 0 || index >= this.queue.length) return
    this.leaveRadio()
    await this.switchToIndex(index)
  },

  async seek(position: number): Promise<void> {
    if (this.preview) return // excerpts, nothing to seek in
    const connect = useConnectStore()
    if (connect.isActive) {
      await connectPlayback.seek(position)
      // Re-anchors the extrapolation interval (see positionTracker.ts's
      // own comment) to the seeked-to position right away — otherwise
      // it'd keep extrapolating from the pre-seek anchor for up to ~200ms
      // and briefly overwrite this seek with a stale position.
      positionTracker.record(position, performance.now())
    } else if (this.currentSong && getLocalMix().active) {
      // A mix is seeked by starting it over from there, like a transcode.
      this.startLocalSong(this.currentSong, position, this.isPlaying)
    } else if (
      this.currentSong &&
      this.activeLocalStream &&
      this.activeLocalStream.quality.format !== 'original' &&
      !prefersHls()
    ) {
      // A transcode has no length to seek within — the position is
      // fetched rather than scrubbed to. See startLocalSong(), which
      // explains why, and note that the byte-range seek this replaces
      // already re-ran ffmpeg from the target second: the cost is the
      // same, only the arithmetic in between is gone. Not as HLS, whose
      // playlist covers the whole track and is seeked in like a file.
      this.startLocalSong(this.currentSong, position, this.isPlaying)
    } else {
      getAudioEngine().seek(position)
    }
    this.localPosition = position
  },

  setVolume(volume: number): void {
    this.volume = volume
    getAudioEngine().setVolume(volume)
  },

  async stop(): Promise<void> {
    if (this.preview) {
      this.endPreview()
      return
    }
    const connect = useConnectStore()
    if (connect.isActive) {
      // Also stops this session's radio-metadata watch on the backend,
      // if one was running — see routes/playback.py's /stop.
      await connectPlayback.stop()
    } else {
      getLocalMix().stop()
      getAudioEngine().stop()
      if (this.radioStation) stopRadioMetadataWatch()
    }
    this.isPlaying = false
    this.localPosition = 0
    this.bufferedPosition = 0
    useRadioMetadataStore().reset()
    this.radioConnectionLost = false
    // Same reasoning as prepareLocalPlayback()'s identical reset —
    // nothing is casting (or playing at all) any more to still be
    // filling a startup buffer, and the SSE handler that normally clears
    // this stopped updating the moment casting became inactive.
    this.radioBuffering = false
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
  async playSongList(songs: Song[], startIndex = 0, pinFirst = true, peek = false): Promise<void> {
    this.setQueue(songs, startIndex, pinFirst)
    if (peek) useDrawersStore().peekQueueDrawer(this.queue)
    await this.startCurrent()
  },
}
