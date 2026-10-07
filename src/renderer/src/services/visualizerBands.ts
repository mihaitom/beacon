// 60 bars, logarithmically spaced from 20Hz to 22050Hz — works out to
// roughly 1/6-octave bands (log2(22050/20)/60 ≈ 0.168 octaves/bar, close
// enough to true 1/6-octave that the difference isn't perceptible). See
// connect/core/audio_analysis.py's identical band mapping for 'cast'
// mode, which this must visually match.
export const BAR_COUNT = 60
export const MIN_FREQ_HZ = 20
export const MAX_FREQ_HZ = 22050

// The backend sends roughly as many bands as this draws bars
// (_BAND_COUNT in audio_analysis.py) but not necessarily exactly —
// linear interpolation between the two nearest bands stretches one
// onto the other smoothly. Nearest-index resampling (tried first)
// duplicated each band across multiple adjacent bars whenever there
// were meaningfully fewer bands than bars, which read as neighboring
// bars visibly moving in lockstep "groups" instead of independently.
export function resampleBands(bands: number[] | null | undefined): number[] | null {
  if (!bands || bands.length === 0) return null
  if (bands.length === 1) return Array.from({ length: BAR_COUNT }, () => bands[0]!)
  const heights = Array.from<number>({ length: BAR_COUNT })
  for (let i = 0; i < BAR_COUNT; i++) {
    const position = (i / (BAR_COUNT - 1)) * (bands.length - 1)
    const lower = Math.floor(position)
    const upper = Math.min(bands.length - 1, lower + 1)
    const t = position - lower
    const a = bands[lower] ?? 0
    const b = bands[upper] ?? 0
    heights[i] = a + (b - a) * t
  }
  return heights
}
