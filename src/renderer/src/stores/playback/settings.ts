/** Standing preferences: Autoplay, ReplayGain and stream quality. */
import { getAudioEngine } from '@/services/audioEngine'
import type { ReplayGainMode } from '@/services/replayGain'
import { bitrateFor, save as saveStreamQuality, type StreamFormat } from '@/services/streamQuality'
import { useAutoplayStore } from '../autoplay'
import { getLocalMix } from '@/services/playback/localMix'
import type { PlaybackContext } from './context'

export interface SettingsActions {
  setAutoplayEnabled(value: boolean): void
  setReplayGainMode(mode: ReplayGainMode): void
  setLocalQuality(format: StreamFormat, bitrate?: number): void
  setCastQuality(format: StreamFormat, bitrate?: number): void
  persistQuality(): void
}

export const settingsActions: SettingsActions & ThisType<PlaybackContext> = {
  /** The Autoplay toggle. While casting this is a setting of the session
   * rather than of this device (see adoptCastQueue(), which adopts it
   * from the status the same way it does shuffle/repeat), so switching it
   * has to reach connect right away instead of riding along with whatever
   * queue update happens to come next — until it does, the backend keeps
   * topping the queue up from the old value. That part is skipped when
   * not casting, since syncCastQueue() returns early then. */
  setAutoplayEnabled(value: boolean): void {
    useAutoplayStore().setEnabled(value)
    this.syncCastQueue()
    // Switching it on has to top up here and not wait for the usual
    // trigger, a song change: on the last song of the queue there is no
    // next song change coming, so playback would stop anyway with the
    // toggle sitting visibly on.
    if (value) void this.maybeAutoplay()
  },

  /** Settings-driven — applies immediately to local playback (a live Web
   * Audio GainNode, see AudioEngine.setReplayGain()), so switching modes
   * doesn't need a skip to take effect there. Casting can't be updated
   * live the same way — connect/playback.ts's `gain` is baked into
   * ffmpeg's `volume` filter argument when the stream starts (see
   * core/streamer.py), not a value the running stream can be told to
   * change — so a mode switch while casting only takes effect from the
   * next song start onward, same as any other cast-side setting would.
   * connect starts those songs itself, so it is told the new mode now. */
  setReplayGainMode(mode: ReplayGainMode): void {
    this.replayGainMode = mode
    if (this.isCasting) this.syncCastQueue()
    // A mix applies gain per song itself and is told the new values for
    // the songs still to come; the element's own stays flat.
    else if (getLocalMix().active) this.syncLocalMixQueue()
    else getAudioEngine().setReplayGain(this.replayGainMultiplier)
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
}
