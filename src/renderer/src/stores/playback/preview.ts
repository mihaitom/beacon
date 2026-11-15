/** Previews: excerpts of an album, a playlist or single tracks. */
import { getAudioEngine } from '@/services/audioEngine'
import { mixQuality } from '@/services/streamQuality'
import * as connectPlayback from '@/services/connect/playback'
import type { ConnectStatus } from '@/services/connect/types'
import type { Song } from '@/types/library'
import { sameIds } from '@/services/playback/queueOps'
import { getLocalMix, mixSong } from '@/services/playback/localMix'
import { isExternalSong, pickPreviewSongs } from '@/services/playback/preview'
import { resolveSongs } from './shared'
import type { PlaybackContext } from './context'

// Preview requests to connect still on their way - see adoptCastPreview(),
// which leaves the preview alone meanwhile.
let castPreviewRequests = 0

export interface PreviewActions {
  startPreview(songs: Song[]): Promise<void>
  startTracksPreview(songs: Song[]): Promise<void>
  playPreviewAt(index: number): Promise<void>
  previewNext(): Promise<void>
  playFromPreview(): Promise<void>
  adoptCastPreview(status: ConnectStatus): Promise<void>
  endPreview(): void
}

export const previewActions: PreviewActions & ThisType<PlaybackContext> = {
  /** Previews `songs` - an album or a playlist: an excerpt of a few of
   * them, blended into each other (connect/core/preview.py), here or on
   * the speakers being cast to. The queue stays as it is, nothing is
   * scrobbled, and the end is silence, with the queue's song back where
   * it was (endPreview()). */
  async startPreview(songs: Song[]): Promise<void> {
    const picks = pickPreviewSongs(songs)
    if (!picks.length) return
    // A preview of something else in the middle of one goes back to
    // where the queue was before the first. While casting connect keeps
    // this itself, and its status corrects it (adoptCastPreview()).
    const resumeAt = this.preview?.resumeAt ?? this.localPosition
    this.leaveRadio()
    this.preview = { songs, picks, index: 0, resumeAt, whole: true }
    await this.playPreviewAt(0)
  },

  /** Previews tracks that need not be in the library, all of them in
   * their order - a playlist builder row, or a suggested artist's top
   * tracks - as their 30-second Deezer previews (deezerPreviewSong()).
   * Everything else is startPreview()'s: the queue pauses and waits,
   * on this device or the speakers, and the end is silence. There is no
   * album or playlist to "Play from here" (`whole`). */
  async startTracksPreview(songs: Song[]): Promise<void> {
    if (!songs.length) return
    const resumeAt = this.preview?.resumeAt ?? this.localPosition
    this.leaveRadio()
    this.preview = { songs, picks: songs.map((_, i) => i), index: 0, resumeAt, whole: false }
    await this.playPreviewAt(0)
  },

  /** Starts the preview over from its `index`-th excerpt - next and
   * previous, and a resume after a long pause, like a mix's skip. */
  async playPreviewAt(index: number): Promise<void> {
    const preview = this.preview
    if (!preview) return
    preview.index = index
    this.duration = this.currentSong?.duration ?? 0
    this.localPosition = 0
    this.bufferedPosition = 0
    this.mixNextLocked = false
    this.mixTransitions = []
    this.isPlaying = true
    const songs = preview.picks.map((i, k) => mixSong(preview.songs[i]!, k, this.replayGainMode))
    if (this.isCasting) {
      castPreviewRequests++
      try {
        await connectPlayback.startPreview(songs, index)
      } catch (error) {
        console.error('[playback] Could not start the preview on the speakers:', error)
        this.endPreview()
      } finally {
        castPreviewRequests--
      }
      return
    }
    const quality = mixQuality(this.localQuality)
    this.activeLocalStream = { quality, reason: 'transitions' }
    try {
      await getLocalMix().startPreview({ songs, index, quality })
    } catch (error) {
      console.error('[playback] Could not start the preview:', error)
      this.endPreview()
    }
  },

  async previewNext(): Promise<void> {
    const preview = this.preview
    if (!preview) return
    if (preview.index + 1 < preview.picks.length) await this.playPreviewAt(preview.index + 1)
    else this.endPreview()
  },

  /** "Play from here": the album or playlist, from the song previewed
   * now, as an ordinary play from its start - the library's songs of it
   * only, so not while a missing track's Deezer preview plays. */
  async playFromPreview(): Promise<void> {
    const preview = this.preview
    const current = this.currentSong
    if (!preview || !current || isExternalSong(current)) return
    this.preview = null
    const songs = preview.songs.filter((song) => !isExternalSong(song))
    await this.playSongList(songs, songs.indexOf(current))
  },

  /** Takes up a preview on the speakers from connect's status - one this
   * client started, or another one sharing the session. One from
   * elsewhere only knows the songs it previews, so "Play from here" has
   * no album or playlist to play (`whole`). */
  async adoptCastPreview(status: ConnectStatus): Promise<void> {
    // A start, a skip or an end of our own is on its way: the tick in
    // hand was built before connect had it.
    if (castPreviewRequests > 0) return
    const remote = status.preview
    if (!remote) {
      this.preview = null
      return
    }
    const own = this.preview
    if (
      own &&
      sameIds(
        own.picks.map((i) => own.songs[i]!.id),
        remote.song_ids,
      )
    ) {
      own.index = remote.index
      own.resumeAt = remote.resume_at
      return
    }
    const resolved = await resolveSongs(remote.song_ids, [])
    if (castPreviewRequests > 0 || !resolved) return
    this.preview = {
      songs: resolved,
      picks: resolved.map((_, i) => i),
      index: remote.index,
      resumeAt: remote.resume_at,
      whole: false,
    }
  },

  /** Ends a preview: silent, with the queue's song loaded paused where
   * the preview interrupted it - pressing play carries on there. While
   * casting connect puts the session back the same way. */
  endPreview(): void {
    const preview = this.preview
    if (!preview) return
    this.preview = null
    this.isPlaying = false
    this.bufferedPosition = 0
    this.localPosition = preview.resumeAt
    if (this.isCasting) {
      castPreviewRequests++
      void connectPlayback
        .endPreview()
        .catch((error) => console.error('[playback] Could not end the preview:', error))
        .finally(() => castPreviewRequests--)
      return
    }
    getLocalMix().stop()
    const song = this.currentSong
    if (!song) {
      getAudioEngine().stop()
      this.duration = 0
      return
    }
    this.duration = song.duration
    this.startLocalSong(song, preview.resumeAt, false)
  },
}
