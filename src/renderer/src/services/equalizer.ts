/** A ten-band graphic equalizer: the bands, the presets, and the curve they
 * add up to.
 *
 * Every band is the RBJ cookbook peaking biquad - what Web Audio's
 * BiquadFilterNode ('peaking') and ffmpeg's `equalizer` filter both are - so
 * one curve sounds the same on this device and on a speaker. The bands are
 * sent to connect as numbers (see toBands()), never defined there a second
 * time; connect/core/equalizer.py works out the same headroom from them. */

/** ISO octave centres, 31 Hz to 16 kHz. */
export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const

/** Octave-wide bands: neighbours meet at about half their gain, which is
 * what keeps a run of equal boosts reasonably flat instead of rippled. */
export const EQ_Q = 1.41

export const EQ_MAX_GAIN_DB = 12

/** A single dB step is finer than anyone hears on a band this wide. */
export const EQ_STEP_DB = 1

export interface EqualizerSetting {
  enabled: boolean
  /** One gain in dB per entry of EQ_FREQUENCIES. */
  gains: number[]
}

/** What connect's /play and /equalizers take per band. */
export interface EqualizerBand {
  frequency: number
  gain: number
  q: number
}

export type EqualizerPreset = 'flat' | 'bass' | 'treble' | 'vocal' | 'loudness' | 'smallSpeaker'

/** Starting points, not targets: picking one and then moving a band makes
 * the curve "Custom". `smallSpeaker` cuts what a small box cannot play
 * rather than boosting it - asking a 3-inch driver for 31 Hz only costs
 * headroom - and lifts the upper bass it can. */
export const EQ_PRESETS: Record<EqualizerPreset, readonly number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  treble: [0, 0, 0, 0, 0, 0, 1, 3, 5, 6],
  vocal: [-2, -2, -1, 0, 2, 3, 3, 2, 0, -1],
  loudness: [5, 4, 2, 0, -1, -1, 0, 2, 3, 4],
  smallSpeaker: [-6, -2, 3, 3, 1, 0, 0, 1, 2, 1],
}

export const EQ_PRESET_NAMES = Object.keys(EQ_PRESETS) as EqualizerPreset[]

export function flatSetting(): EqualizerSetting {
  return { enabled: false, gains: [...EQ_PRESETS.flat] }
}

function clampGain(value: unknown): number {
  const n = Number(value)
  if (value === null || value === undefined || !Number.isFinite(n)) return 0
  return Math.max(
    -EQ_MAX_GAIN_DB,
    Math.min(EQ_MAX_GAIN_DB, Math.round(n / EQ_STEP_DB) * EQ_STEP_DB),
  )
}

/** Anything read back from storage or the wire, made into a setting: the
 * right number of bands, each a whole step inside the range. */
export function sanitizeSetting(value: unknown): EqualizerSetting {
  const raw = (value ?? {}) as Partial<EqualizerSetting>
  const gains = Array.isArray(raw.gains) ? raw.gains : []
  return {
    enabled: raw.enabled === true,
    gains: EQ_FREQUENCIES.map((_, i) => clampGain(gains[i])),
  }
}

export function isFlat(gains: readonly number[]): boolean {
  return gains.every((g) => g === 0)
}

/** Whether this setting changes anything at all - switched on, and not
 * flat. Only then does it cost a filter, or a speaker's copy tier. */
export function isActive(setting: EqualizerSetting): boolean {
  return setting.enabled && !isFlat(setting.gains)
}

/** The preset these gains are, or null for a curve of one's own. */
export function presetOf(gains: readonly number[]): EqualizerPreset | null {
  return EQ_PRESET_NAMES.find((name) => EQ_PRESETS[name].every((g, i) => g === gains[i])) ?? null
}

/** The bands connect is sent, flat ones left out. Empty when the setting
 * does nothing. */
export function toBands(setting: EqualizerSetting): EqualizerBand[] {
  if (!setting.enabled) return []
  return EQ_FREQUENCIES.flatMap((frequency, i) =>
    setting.gains[i] ? [{ frequency, gain: setting.gains[i], q: EQ_Q }] : [],
  )
}

/** The rate the response is worked out at - see core/equalizer.py's
 * _RESPONSE_RATE, which this has to match for the two to agree. */
const RESPONSE_RATE = 48000

/** One peaking band's magnitude in dB at `frequency`. */
function peakingDb(band: EqualizerBand, frequency: number): number {
  const a = 10 ** (band.gain / 40)
  const w0 = (2 * Math.PI * band.frequency) / RESPONSE_RATE
  const alpha = Math.sin(w0) / (2 * band.q)
  const cos = Math.cos(w0)
  const [b0, b1, b2] = [1 + alpha * a, -2 * cos, 1 - alpha * a]
  const [a0, a1, a2] = [1 + alpha / a, -2 * cos, 1 - alpha / a]
  const w = (2 * Math.PI * frequency) / RESPONSE_RATE
  // |H(e^jw)|: real and imaginary parts of numerator and denominator.
  const re = (c0: number, c1: number, c2: number) => c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w)
  const im = (c1: number, c2: number) => -(c1 * Math.sin(w) + c2 * Math.sin(2 * w))
  const num = Math.hypot(re(b0, b1, b2), im(b1, b2))
  const den = Math.hypot(re(a0, a1, a2), im(a1, a2))
  return 20 * Math.log10(num / den)
}

/** The whole curve's level in dB at `frequency`, before headroom. */
export function responseDb(bands: readonly EqualizerBand[], frequency: number): number {
  return bands.reduce((sum, band) => sum + peakingDb(band, frequency), 0)
}

const RESPONSE_MIN_HZ = 20
const RESPONSE_MAX_HZ = 20000
const RESPONSE_POINTS = 400

/** `count` frequencies spread evenly on a log scale over the audible range. */
export function logFrequencies(count: number): number[] {
  const ratio = RESPONSE_MAX_HZ / RESPONSE_MIN_HZ
  return Array.from(
    { length: count },
    (_, i) => RESPONSE_MIN_HZ * ratio ** (i / Math.max(1, count - 1)),
  )
}

/** How far the whole curve is lowered so its loudest point stays at 0 dB:
 * the highest point of the combined response, since two neighbouring
 * boosts add up between them. 0 for a curve that only cuts. */
export function headroomDb(bands: readonly EqualizerBand[]): number {
  if (bands.length === 0) return 0
  return Math.max(0, ...logFrequencies(RESPONSE_POINTS).map((f) => responseDb(bands, f)))
}
