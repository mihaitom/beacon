import type { Song } from '@/types/library'

export type ReplayGainMode = 'off' | 'song' | 'album'

/** Linear amplitude multiplier (1 = no change) to apply to `song` under
 * `mode` — fed straight into AudioEngine.setReplayGain()'s Web Audio
 * GainNode. Falls back to the other of song/album gain when the preferred
 * one is missing (same fallback OpenSubsonic/Jellyfin clients use — a lone
 * bonus song with no album context still has trackGain, and vice versa).
 * Clips the result against the song's peak (when known) so a quiet,
 * heavily-gained master can't be pushed past 0dBFS into audible clipping —
 * https://wiki.hydrogenaud.io/index.php?title=ReplayGain_1.0_specification#section=19 */
export function calculateReplayGain(song: Pick<Song, 'replayGain'>, mode: ReplayGainMode): number {
  if (mode === 'off' || !song.replayGain) return 1

  const { trackGain, albumGain, trackPeak, albumPeak } = song.replayGain
  const gain = mode === 'song' ? (trackGain ?? albumGain) : (albumGain ?? trackGain)
  if (gain === undefined) return 1

  const multiplier = 10 ** (gain / 20)
  if (!Number.isFinite(multiplier)) return 1

  const peak = mode === 'song' ? (trackPeak ?? albumPeak) : (albumPeak ?? trackPeak)
  return peak ? Math.min(multiplier, 1 / peak) : multiplier
}
