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

/** BAR_COUNT bar heights (0..1) from a Web Audio analyser, each bar the
 * average of its own logarithmic slice of the bins - the same slicing
 * connect/core/audio_analysis.py does for a cast. `data` is reused between
 * frames; a fresh one is made when the analyser's size does not fit it. */
export function analyserBands(
  analyser: AnalyserNode,
  data: Uint8Array<ArrayBuffer> | null,
): { heights: number[]; data: Uint8Array<ArrayBuffer> } {
  const bins =
    data && data.length === analyser.frequencyBinCount
      ? data
      : new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(bins)
  const binHz = analyser.context.sampleRate / analyser.fftSize
  const ratio = MAX_FREQ_HZ / MIN_FREQ_HZ
  const heights = Array.from<number>({ length: BAR_COUNT })
  for (let i = 0; i < BAR_COUNT; i++) {
    const loFreq = MIN_FREQ_HZ * ratio ** (i / BAR_COUNT)
    const hiFreq = MIN_FREQ_HZ * ratio ** ((i + 1) / BAR_COUNT)
    const loBin = Math.max(0, Math.floor(loFreq / binHz))
    const hiBin = Math.min(bins.length, Math.max(loBin + 1, Math.ceil(hiFreq / binHz)))
    let sum = 0
    for (let bin = loBin; bin < hiBin; bin++) sum += bins[bin] ?? 0
    heights[i] = sum / (hiBin - loBin) / 255
  }
  return { heights, data: bins }
}
