import type { Track } from '@/types/library'

export type ReplayGainMode = 'off' | 'track' | 'album'

/** Linear amplitude multiplier (1 = no change) to apply to `track` under
 * `mode` — fed straight into AudioEngine.setReplayGain()'s Web Audio
 * GainNode. Falls back to the other of track/album gain when the preferred
 * one is missing (same fallback OpenSubsonic/Jellyfin clients use — a lone
 * bonus track with no album context still has trackGain, and vice versa).
 * Clips the result against the track's peak (when known) so a quiet,
 * heavily-gained master can't be pushed past 0dBFS into audible clipping —
 * https://wiki.hydrogenaud.io/index.php?title=ReplayGain_1.0_specification#section=19 */
export function calculateReplayGain(
  track: Pick<Track, 'replayGain'>,
  mode: ReplayGainMode,
): number {
  if (mode === 'off' || !track.replayGain) return 1

  const { trackGain, albumGain, trackPeak, albumPeak } = track.replayGain
  const gain = mode === 'track' ? (trackGain ?? albumGain) : (albumGain ?? trackGain)
  if (gain === undefined) return 1

  const multiplier = 10 ** (gain / 20)
  if (!Number.isFinite(multiplier)) return 1

  const peak = mode === 'track' ? (trackPeak ?? albumPeak) : (albumPeak ?? trackPeak)
  return peak ? Math.min(multiplier, 1 / peak) : multiplier
}
