/** The playback store's state - see stores/playback.ts. */
import type { ReplayGainMode } from '@/services/replayGain'
import type { LocalStreamPlan, StreamQuality } from '@/services/streamQuality'
import type { MixTransition } from '@/services/connect/types'
import type { RadioStation, Song } from '@/types/library'
import type { RepeatMode } from '@/services/playback/types'

/** The queue's key positions a song can be sent to - see moveInQueue(). */
export type QueueMoveTarget = 'next' | 'end'

/** See PlaybackState.preview and startPreview(). */
export interface PreviewState {
  /** The album or playlist, whole - "Play from here" plays it. */
  songs: Song[]
  /** Which of them the preview plays, in order (pickPreviewSongs()). */
  picks: number[]
  /** Where in `picks` it is. */
  index: number
  /** Where the queue's song was when the preview began. */
  resumeAt: number
  /** Whether `songs` is the whole album or playlist - false for a preview
   * taken up from another client sharing a cast, which only knows the
   * songs previewed. */
  whole: boolean
}

export interface PlaybackState {
  originalQueue: Song[]
  queue: Song[]
  /** The AudioMuse mood the queue was started from (Home's mood tiles),
   * until anything else replaces the queue. */
  moodMix: string | null
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
  /** With transitions on: the mix has settled on the song after the
   * current one - rendered it, or begun blending it in - so it stays where
   * it is. From the local mix (followLocalMix()) or, while casting, from
   * connect's status. See lockedNextIndex. */
  mixNextLocked: boolean
  /** With transitions on: how the songs heard now blend into the next,
   * from the same two places as mixNextLocked. See upcomingTransition. */
  mixTransitions: MixTransition[]
  /** A preview of an album or playlist playing over the queue, which it
   * leaves alone - see startPreview(). */
  preview: PreviewState | null
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
  /** True only while casting radio to a Chromecast/DLNA target whose own
   * position hasn't shown real movement yet — see connect/core/
   * radio_position.py. Drives the "still buffering" state on the seek
   * bar's live-time label (SeekBar.vue/MobileTransportControls.vue)
   * instead of a frozen or misleading elapsed time. */
  radioBuffering: boolean
  /** True once local playback has stopped trying to reconnect a dropped
   * station on its own — the end of audioEngine.ts's reconnect ladder (see
   * its onConnectionLost). RadioLiveStatus.vue turns this into the one
   * thing the player bar has never offered for a station that went quiet:
   * a way to try again without hunting the station down in the library.
   *
   * Local playback only. A cast target's own drops are the backend's to
   * notice and retry (core/radio_relay.py never stops trying), and nothing
   * about this device's connection says anything about the speaker's. */
  radioConnectionLost: boolean
  initialized: boolean
}
