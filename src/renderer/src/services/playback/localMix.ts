/** Transitions for this device's own player.
 *
 * With transitions on, songs are not fetched one by one: connect mixes them
 * into one stream (connect/routes/local_mix.py) and the element plays that
 * as a single long source - an offset stream to the AudioEngine, which
 * reports stream time and reconnects from wherever it had got to. What
 * this adds on top is the timeline, fetched alongside, which says which
 * song plays at which stream time.
 *
 * Every manual change - a seek, a skip, picking a song - starts the mix
 * over (a new `epoch`); songs following each other on their own happen
 * inside the stream. See docs/plans/gapless-and-transitions.md.
 *
 * WebKit gets the run as a live HLS playlist instead (see prefersHls()):
 * the element's clock is stream time there too, from the run's start. */

import { getAudioEngine } from '@/services/audioEngine'
import {
  fetchLocalMixTimeline,
  localMixAudioUrl,
  localMixHlsUrl,
  pauseLocalMix,
  resumeLocalMix,
  startLocalMix,
  startLocalPreview,
  stopLocalMix,
  updateLocalMixQueue,
  type LocalMixSong,
  type LocalMixState,
} from '@/services/connect/localMix'
import type { MixTransition } from '@/services/connect/types'
import { calculateReplayGain, type ReplayGainMode } from '@/services/replayGain'
import { prefersHls, type LocalStreamQuality } from '@/services/streamQuality'
import type { Song } from '@/types/library'
import {
  heardAt,
  loadedThrough,
  songFollows,
  type MixHeard,
  type MixTimelineEntry,
} from './mixTimeline'
import type { RepeatMode } from './types'
import type { TransitionsPayload } from '@/stores/transitions'

/** How often the timeline is asked for while playing. A song change is
 * rendered ~20s before it is heard, so this only has to be well inside
 * that. */
const TIMELINE_POLL_MS = 2000

/** How many songs past the current one the mix is told about. */
const SONGS_AHEAD = 10

/** A pause longer than this is resumed by starting the mix over from where
 * it stood: connect's decoders hold a connection to the media server each,
 * and one left idle that long may well have been dropped at the far end. */
export const STALE_PAUSE_MS = 120_000

/** The songs a mix should play from the current one on, in play order -
 * repeat-all's wrap included. Repeat-one needs only the current song: the
 * mix loops it by itself. */
export function upcomingSongs(
  queue: readonly Song[],
  currentIndex: number,
  repeatMode: RepeatMode,
  replayGainMode: ReplayGainMode,
): LocalMixSong[] {
  if (currentIndex < 0 || currentIndex >= queue.length) return []
  const indices = [currentIndex]
  if (repeatMode !== 'one') {
    for (let step = 1; step <= SONGS_AHEAD; step++) {
      const index = currentIndex + step
      if (index < queue.length) indices.push(index)
      else if (repeatMode === 'all' && queue.length > 1) indices.push(index % queue.length)
      else break
    }
  }
  return indices.map((index) => mixSong(queue[index]!, index, replayGainMode))
}

/** `song` as connect's mix takes it, at `index` in whatever list it is
 * sent with. */
export function mixSong(song: Song, index: number, replayGainMode: ReplayGainMode): LocalMixSong {
  return {
    id: song.id,
    queue_index: index,
    gain: calculateReplayGain(song, replayGainMode),
    duration: song.duration,
    album_id: song.albumId,
    disc: song.discNumber,
    track: song.trackNumber,
    bpm: song.bpm ?? null,
    artist: song.artist,
    title: song.title,
  }
}

function newPlayerId(): string {
  const random = crypto.getRandomValues(new Uint8Array(9))
  return `p${Array.from(random, (b) => b.toString(36).padStart(2, '0')).join('')}`.slice(0, 20)
}

export interface LocalMixStart {
  songs: LocalMixSong[]
  position: number
  repeatMode: RepeatMode
  transitions: TransitionsPayload
  quality: LocalStreamQuality
  autoplay: boolean
}

export class LocalMixPlayer {
  /** This tab's own key for its mix: a session is a login, shared by every
   * device on it, so connect tells tabs apart by this. */
  readonly player = newPlayerId()
  private epoch: string | null = null
  private timeline: MixTimelineEntry[] = []
  private end: number | null = null
  private nextCommitted = false
  private upcoming: MixTransition[] = []
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private startSeq = 0
  private pausedAt: number | null = null
  /** The stream time last asked about through heard(): where this tab is. */
  private heardTime = 0
  /** connect no longer has this mix (it was stopped, or connect restarted)
   * while this tab still played it. */
  onLost: (() => void) | null = null

  get active(): boolean {
    return this.epoch !== null
  }

  /** Starts a new run of the mix and hands it to the element. False when a
   * newer start or a stop took over while connect was answering. */
  async start(options: LocalMixStart): Promise<boolean> {
    const seq = ++this.startSeq
    const state = await startLocalMix(this.player, {
      songs: options.songs,
      position: options.position,
      repeat_mode: options.repeatMode,
      transitions: options.transitions,
      // Loaded without playing: connect's clock waits for resume() too.
      paused: !options.autoplay,
    })
    if (seq !== this.startSeq) return false
    this.play(state, options.quality, options.autoplay)
    return true
  }

  /** Starts a preview (connect/core/preview.py) from songs[index] and
   * hands it to the element - a run like a mix's, of excerpts. False when
   * a newer start or a stop took over. */
  async startPreview(options: {
    songs: LocalMixSong[]
    index: number
    quality: LocalStreamQuality
  }): Promise<boolean> {
    const seq = ++this.startSeq
    const state = await startLocalPreview(this.player, {
      songs: options.songs,
      index: options.index,
    })
    if (seq !== this.startSeq) return false
    this.play(state, options.quality, true)
    return true
  }

  private play(state: LocalMixState, quality: LocalStreamQuality, autoplay: boolean): void {
    this.adopt(state)
    const epoch = state.epoch
    const engine = getAudioEngine()
    // Gain is the mixer's (each song at its own); the element's stays flat.
    if (prefersHls()) {
      const url = localMixHlsUrl(this.player, epoch, quality)
      if (autoplay) engine.play(url, 0, 1, { hls: true, mix: true })
      else engine.load(url, 0, 1, { hls: true, mix: true })
      // A live playlist may start near its live edge; the run plays from
      // its start. The engine holds the seek until the player has media.
      engine.seek(0)
    } else {
      const urlFor = (from: number): string => localMixAudioUrl(this.player, epoch, from, quality)
      if (autoplay) engine.playFrom(urlFor, 0, 1, Number.POSITIVE_INFINITY)
      else engine.loadFrom(urlFor, 0, 1, Number.POSITIVE_INFINITY)
    }
    this.applyEnd()
    this.pausedAt = autoplay ? null : Date.now()
    this.startPolling()
  }

  /** What is heard at stream time `streamTime`. */
  heard(streamTime: number): MixHeard | null {
    this.heardTime = streamTime
    return heardAt(this.timeline, streamTime)
  }

  /** Whether the song after the one last heard is settled in the mix -
   * rendered already, or blending in - so a queue edit can no longer
   * change it. */
  get nextLocked(): boolean {
    return this.active && (this.nextCommitted || songFollows(this.timeline, this.heardTime))
  }

  /** How the songs around the one last heard blend into the next - see
   * MixTransition. */
  get transitions(): MixTransition[] {
    return this.upcoming
  }

  /** How far the song last heard is loaded, given the element holds the
   * stream up to `streamEnd` - see mixTimeline.ts's loadedThrough(). */
  loadedThrough(streamEnd: number): number | null {
    return loadedThrough(this.timeline, this.heardTime, streamEnd)
  }

  /** Which mix this tab plays and where in it, for a party's listen-along:
   * connect reads guests the same mix from there (core/party.py). */
  partyState(): { player: string; epoch: string; stream_time: number } | null {
    if (this.epoch === null) return null
    return { player: this.player, epoch: this.epoch, stream_time: this.heardTime }
  }

  syncQueue(songs: LocalMixSong[], repeatMode: RepeatMode): void {
    if (!this.active || songs.length === 0) return
    void updateLocalMixQueue(this.player, songs, repeatMode).catch((error) =>
      console.error('[local-mix] Failed to update the queue:', error),
    )
  }

  pause(): void {
    if (!this.active) return
    this.pausedAt = Date.now()
    this.stopPolling()
    void pauseLocalMix(this.player).catch(() => {})
  }

  resume(): void {
    if (!this.active) return
    this.pausedAt = null
    this.startPolling()
    void resumeLocalMix(this.player).catch(() => {})
  }

  /** How long the mix has been paused, in ms; 0 while it plays. */
  pausedFor(now = Date.now()): number {
    return this.pausedAt === null ? 0 : now - this.pausedAt
  }

  /** Ends the mix. Also cancels a start still waiting for connect. */
  stop(): void {
    this.startSeq++
    this.stopPolling()
    const wasActive = this.active
    this.epoch = null
    this.timeline = []
    this.end = null
    this.nextCommitted = false
    this.upcoming = []
    this.pausedAt = null
    this.heardTime = 0
    if (wasActive) void stopLocalMix(this.player).catch(() => {})
  }

  private adopt(state: LocalMixState): void {
    if (state.epoch !== this.epoch) this.heardTime = 0
    this.epoch = state.epoch
    this.timeline = state.timeline
    this.end = state.end
    this.nextCommitted = state.next_committed
    this.upcoming = state.transitions ?? []
  }

  private applyEnd(): void {
    if (this.end !== null) getAudioEngine().setExpectedDuration(this.end)
  }

  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = setInterval(() => void this.refresh(), TIMELINE_POLL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer === null) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private async refresh(): Promise<void> {
    const epoch = this.epoch
    if (epoch === null) return
    try {
      const state = await fetchLocalMixTimeline(this.player, epoch)
      if (this.epoch !== epoch) return
      this.adopt(state)
      this.applyEnd()
    } catch (error) {
      if (this.epoch !== epoch) return
      const detail = (error as { body?: { detail?: unknown } }).body?.detail
      if (detail === 'No such mix') {
        this.stopPolling()
        this.epoch = null
        this.onLost?.()
      }
    }
  }
}

let instance: LocalMixPlayer | null = null

export function getLocalMix(): LocalMixPlayer {
  instance ??= new LocalMixPlayer()
  return instance
}
