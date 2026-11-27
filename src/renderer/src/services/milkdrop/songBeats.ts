/** The playing song's beats for Milkdrop, from connect's analysis of it -
 * the same beats the room lights land on, so picture and lights flash
 * together. A song still being analysed, one without a beat to follow and
 * radio have none, and the preset goes by its own detection then. */

import { getSongAnalysis } from '@/services/connect/lights'
import { analysedSong, playbackClock, type PreviewSong } from '@/services/lights/stagePreview'
import type { BeatNow } from './beatSignal'

// connect takes 1-2 s for a pop song; asked again this often meanwhile.
const ANALYSIS_POLL_MS = 1000

interface Followed {
  songId: string
  song: PreviewSong | null
  heardFrom: number
}

export class SongBeats {
  private followed: Followed | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private clock = playbackClock()

  /** The song to follow; null for none. */
  follow(songId: string | null): void {
    if (songId === (this.followed?.songId ?? null)) return
    clearTimeout(this.timer)
    this.clock = playbackClock()
    this.followed = songId ? { songId, song: null, heardFrom: 1 } : null
    if (songId) void this.load(songId)
  }

  stop(): void {
    this.follow(null)
  }

  /** The beat at the song's `position` (seconds), run on smoothly between
   * the steps the app reports it in. */
  at(now: number, position: number, playing: boolean): BeatNow | null {
    const followed = this.followed
    if (!followed?.song) return null
    const beat = followed.song.beatAt(this.clock(now, position, playing))
    if (!beat) return null
    const hit = followed.song.hit(beat[0])
    return { index: beat[0], strength: hit >= followed.heardFrom ? hit : 0 }
  }

  private async load(songId: string): Promise<void> {
    let reply: Awaited<ReturnType<typeof getSongAnalysis>> | null = null
    try {
      reply = await getSongAnalysis(songId)
    } catch (error) {
      console.error('[milkdrop] Could not load the beats:', error)
    }
    const followed = this.followed
    if (followed?.songId !== songId) return
    if (reply?.status === 'ready') {
      followed.song = reply.beats ? analysedSong(reply) : null
      followed.heardFrom = reply.heard_from
    } else if (reply?.status === 'pending') {
      this.timer = setTimeout(() => void this.load(songId), ANALYSIS_POLL_MS)
    }
  }
}
