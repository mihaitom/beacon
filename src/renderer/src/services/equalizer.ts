/** A ten-band graphic equalizer, or an imported headphone profile in its
 * place: the bands, the presets, and the curve they add up to.
 *
 * Every band is an RBJ cookbook biquad - peaking for the ten bands, low and
 * high shelves as well in a profile - which is what ffmpeg's `equalizer`,
 * `lowshelf` and `highshelf` filters are and what this device plays (see
 * services/audioEngine.ts's setEqualizer()), so one curve sounds the same
 * on this device and on a speaker. The bands are sent to connect as numbers
 * (see toBands()), never defined there a second time;
 * connect/core/equalizer.py works out the same headroom from them. */

/** ISO octave centres, 31 Hz to 16 kHz. */
export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const

/** Octave-wide bands: neighbours meet at about half their gain, which is
 * what keeps a run of equal boosts reasonably flat instead of rippled. */
export const EQ_Q = 1.41

export const EQ_MAX_GAIN_DB = 12

/** A single dB step is finer than anyone hears on a band this wide. */
export const EQ_STEP_DB = 1

export type ShelfType = 'lowshelf' | 'highshelf'

/** What connect's /play and /equalizers take per band. No type is a
 * peaking band. */
export interface EqualizerBand {
  frequency: number
  gain: number
  q: number
  type?: ShelfType
}

/** A filter set imported from a measurement (services/equalizerImport.ts),
 * played exactly as it came instead of the ten bands. */
export interface EqualizerProfile {
  name: string
  filters: EqualizerBand[]
}

export interface EqualizerSetting {
  enabled: boolean
  /** One gain in dB per entry of EQ_FREQUENCIES. */
  gains: number[]
  /** When set, this is the curve, and `gains` are left as they were. */
  profile?: EqualizerProfile | null
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

// The bounds connect/core/equalizer.py's sanitize() holds every band to.
export const PROFILE_MAX_FILTERS = 20
const PROFILE_MAX_GAIN_DB = 20
const MIN_HZ = 20
const MAX_HZ = 20000
const MIN_Q = 0.1
const MAX_Q = 10

function clampGain(value: unknown): number {
  const n = Number(value)
  if (value === null || value === undefined || !Number.isFinite(n)) return 0
  return Math.max(
    -EQ_MAX_GAIN_DB,
    Math.min(EQ_MAX_GAIN_DB, Math.round(n / EQ_STEP_DB) * EQ_STEP_DB),
  )
}

function within(value: unknown, min: number, max: number): number | null {
  const n = Number(value)
  if (value === null || value === undefined || !Number.isFinite(n)) return null
  return Math.max(min, Math.min(max, n))
}

/** A profile's filters read back from storage or the wire: each inside
 * connect's bounds, flat ones dropped (a shelf at 0 dB is no filter). */
export function sanitizeFilters(value: unknown): EqualizerBand[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, PROFILE_MAX_FILTERS).flatMap((entry): EqualizerBand[] => {
    const raw = (entry ?? {}) as Partial<Record<keyof EqualizerBand, unknown>>
    const frequency = within(raw.frequency, MIN_HZ, MAX_HZ)
    const gain = within(raw.gain, -PROFILE_MAX_GAIN_DB, PROFILE_MAX_GAIN_DB)
    const q = within(raw.q, MIN_Q, MAX_Q)
    if (frequency === null || q === null || !gain) return []
    const band: EqualizerBand = { frequency, gain, q }
    if (raw.type === 'lowshelf' || raw.type === 'highshelf') band.type = raw.type
    else if (raw.type !== undefined) return []
    return [band]
  })
}

function sanitizeProfile(value: unknown): EqualizerProfile | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<Record<keyof EqualizerProfile, unknown>>
  const name = String(raw.name ?? '')
    .trim()
    .slice(0, PRESET_NAME_MAX_LENGTH)
  const filters = sanitizeFilters(raw.filters)
  return name && filters.length ? { name, filters } : null
}

/** Anything read back from storage or the wire, made into a setting: the
 * right number of bands, each a whole step inside the range. */
export function sanitizeSetting(value: unknown): EqualizerSetting {
  const raw = (value ?? {}) as Partial<EqualizerSetting>
  const gains = Array.isArray(raw.gains) ? raw.gains : []
  const profile = sanitizeProfile(raw.profile)
  return {
    enabled: raw.enabled === true,
    gains: EQ_FREQUENCIES.map((_, i) => clampGain(gains[i])),
    ...(profile ? { profile } : {}),
  }
}

export function isFlat(gains: readonly number[]): boolean {
  return gains.every((g) => g === 0)
}

/** Whether this setting changes anything at all - switched on, and not
 * flat. Only then does it cost a filter, or a speaker's copy tier. */
export function isActive(setting: EqualizerSetting): boolean {
  return setting.enabled && (!!setting.profile || !isFlat(setting.gains))
}

/** The preset these gains are, or null for a curve of one's own. */
export function presetOf(gains: readonly number[]): EqualizerPreset | null {
  return EQ_PRESET_NAMES.find((name) => sameGains(EQ_PRESETS[name], gains)) ?? null
}

export function sameGains(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i])
}

/** A curve the listener saved under a name of their own, or a profile
 * they imported - then `profile` is set and `gains` mean nothing. */
export interface CustomPreset {
  name: string
  gains: number[]
  profile?: EqualizerProfile
}

export const PRESET_NAME_MAX_LENGTH = 40

/** Saved presets read back from storage or the account: named, one entry
 * per name (the later one wins, as a save under the same name does). */
export function sanitizePresets(value: unknown): CustomPreset[] {
  if (!Array.isArray(value)) return []
  const byName = new Map<string, CustomPreset>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const name = String((entry as { name?: unknown }).name ?? '')
      .trim()
      .slice(0, PRESET_NAME_MAX_LENGTH)
    if (!name) continue
    const { gains, profile } = sanitizeSetting(entry)
    byName.set(name, profile ? { name, gains, profile: { ...profile, name } } : { name, gains })
  }
  return [...byName.values()]
}

/** The bands connect is sent, flat ones left out. Empty when the setting
 * does nothing. */
export function toBands(setting: EqualizerSetting): EqualizerBand[] {
  if (!setting.enabled) return []
  if (setting.profile) return setting.profile.filters.map((band) => ({ ...band }))
  return EQ_FREQUENCIES.flatMap((frequency, i) =>
    setting.gains[i] ? [{ frequency, gain: setting.gains[i], q: EQ_Q }] : [],
  )
}

/** The rate the response is worked out at - see core/equalizer.py's
 * _RESPONSE_RATE, which this has to match for the two to agree. */
const RESPONSE_RATE = 48000

type Coefficients = [number, number, number]

/** The RBJ cookbook biquad for `band` at `rate`: numerator and
 * denominator, as core/equalizer.py's _coefficients() has them. */
export function biquadCoefficients(
  band: EqualizerBand,
  rate: number,
): { feedforward: Coefficients; feedback: Coefficients } {
  const a = 10 ** (band.gain / 40)
  const w0 = (2 * Math.PI * band.frequency) / rate
  const alpha = Math.sin(w0) / (2 * band.q)
  const cos = Math.cos(w0)
  if (!band.type) {
    return {
      feedforward: [1 + alpha * a, -2 * cos, 1 - alpha * a],
      feedback: [1 + alpha / a, -2 * cos, 1 - alpha / a],
    }
  }
  const shelf = 2 * Math.sqrt(a) * alpha
  // The high shelf is the low one with the cosine's sign flipped.
  const sign = band.type === 'lowshelf' ? 1 : -1
  const c = sign * cos
  return {
    feedforward: [
      a * (a + 1 - (a - 1) * c + shelf),
      sign * 2 * a * (a - 1 - (a + 1) * c),
      a * (a + 1 - (a - 1) * c - shelf),
    ],
    feedback: [
      a + 1 + (a - 1) * c + shelf,
      sign * -2 * (a - 1 + (a + 1) * c),
      a + 1 + (a - 1) * c - shelf,
    ],
  }
}

/** One band's magnitude in dB at `frequency`. */
function bandDb(band: EqualizerBand, frequency: number): number {
  const { feedforward, feedback } = biquadCoefficients(band, RESPONSE_RATE)
  const [b0, b1, b2] = feedforward
  const [a0, a1, a2] = feedback
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
  return bands.reduce((sum, band) => sum + bandDb(band, frequency), 0)
}

const RESPONSE_MIN_HZ = 20
const RESPONSE_MAX_HZ = 20000
const RESPONSE_POINTS = 400

/** Where `frequency` sits on a log scale over the audible range, 0 to 1 -
 * how the curve is laid out left to right. */
export function logPosition(frequency: number): number {
  return Math.log(frequency / RESPONSE_MIN_HZ) / Math.log(RESPONSE_MAX_HZ / RESPONSE_MIN_HZ)
}

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

/** An SVG path through `points` (sorted left to right) that runs flat out
 * to `0` and `width` at either end and joins the points with a monotone
 * cubic: smooth through each point, yet never above or below the two it
 * runs between, so two equal neighbours are joined by a straight line
 * rather than a dip. Fritsch-Carlson slopes, drawn as Bezier segments. */
export function smoothPath(points: readonly [number, number][], width: number): string {
  if (points.length === 0) return ''
  const n = points.length
  const widths = points.slice(1).map(([x], i) => x - points[i]![0])
  const secants = points.slice(1).map(([, y], i) => (y - points[i]![1]) / widths[i]!)
  const slopes = points.map((_, i) => {
    if (i === 0 || i === n - 1) return 0
    const [d0, d1] = [secants[i - 1]!, secants[i]!]
    // A peak, a trough or a flat stretch: level there, or it overshoots.
    if (d0 * d1 <= 0) return 0
    // PCHIP's weighted harmonic mean of the two secants.
    const [h0, h1] = [widths[i - 1]!, widths[i]!]
    return (3 * (h0 + h1)) / ((2 * h1 + h0) / d0 + (h1 + 2 * h0) / d1)
  })
  const f = (v: number) => v.toFixed(1)
  let d = `M0,${f(points[0]![1])}L${f(points[0]![0])},${f(points[0]![1])}`
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!
    const [x1, y1] = points[i + 1]!
    const third = (x1 - x0) / 3
    d += `C${f(x0 + third)},${f(y0 + slopes[i]! * third)} ${f(x1 - third)},${f(y1 - slopes[i + 1]! * third)} ${f(x1)},${f(y1)}`
  }
  return `${d}L${f(width)},${f(points[n - 1]![1])}`
}
