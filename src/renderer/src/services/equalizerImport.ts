/** Headphone and room profiles in the Equalizer APO text format, which is
 * what AutoEq's ParametricEQ.txt and FixedBandEQ.txt and REW's filter
 * export all are:
 *
 *   Preamp: -6.2 dB
 *   Filter 1: ON LSC Fc 105 Hz Gain 6.5 dB Q 0.70
 *   Filter 2: ON PK Fc 2900 Hz Gain 4.1 dB Q 2.20
 *
 * The preamp is left out on purpose: it is the file's own headroom, and
 * Beacon works out the headroom from the curve itself (headroomDb()) -
 * taking both would lower the level twice. */

import {
  PRESET_NAME_MAX_LENGTH,
  PROFILE_MAX_FILTERS,
  sanitizeFilters,
  type EqualizerBand,
  type EqualizerProfile,
  type ShelfType,
} from './equalizer'

export type ImportProblem =
  /** No filter in it at all - not a profile, or every filter switched off. */
  | 'empty'
  /** A filter type with no counterpart here (a low-pass, a shelf by slope). */
  | 'unsupported'
  /** Different filters per channel. */
  | 'channels'
  /** A GraphicEQ line: a curve as points, not filters. */
  | 'graphic'
  | 'tooMany'

export class ProfileImportError extends Error {
  constructor(
    readonly problem: ImportProblem,
    /** The filter type, for 'unsupported'. */
    readonly detail = '',
  ) {
    super(detail ? `${problem}: ${detail}` : problem)
  }
}

const TYPES: Record<string, ShelfType | null> = {
  PK: null,
  PEQ: null,
  LSC: 'lowshelf',
  HSC: 'highshelf',
}

/** "Filter 3: ON PK Fc ..." - the number is optional, REW pads with
 * spaces, and a switched-off filter or REW's empty "None" slot is skipped. */
const FILTER_LINE = /^filter\s*\d*\s*:\s*(on|off)\s+(\S+)(.*)$/i

function number(rest: string, label: string): number | null {
  const match = new RegExp(`\\b${label}\\s+(-?\\d+(?:[.,]\\d+)?)`, 'i').exec(rest)
  return match ? Number(match[1]!.replace(',', '.')) : null
}

/** A bandwidth in octaves as the Q that has it. */
function octavesToQ(octaves: number): number {
  const ratio = 2 ** octaves
  return Math.sqrt(ratio) / (ratio - 1)
}

function parseFilter(type: string, rest: string): EqualizerBand {
  const kind = TYPES[type.toUpperCase()]
  const frequency = number(rest, 'Fc')
  const gain = number(rest, 'Gain')
  const octaves = number(rest, 'BW\\s+Oct')
  const q = number(rest, 'Q') ?? (octaves ? octavesToQ(octaves) : null)
  if (kind === undefined || frequency === null || gain === null || q === null) {
    throw new ProfileImportError('unsupported', type)
  }
  return kind ? { frequency, gain, q, type: kind } : { frequency, gain, q }
}

export function parseProfile(text: string): EqualizerBand[] {
  const filters: EqualizerBand[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    if (/^graphiceq\s*:/i.test(line)) throw new ProfileImportError('graphic')
    const channel = /^channel\s*:\s*(.*)$/i.exec(line)
    if (channel && channel[1]!.trim().toLowerCase() !== 'all') {
      throw new ProfileImportError('channels')
    }
    const filter = FILTER_LINE.exec(line)
    if (!filter || filter[1]!.toUpperCase() === 'OFF' || /^none$/i.test(filter[2]!)) continue
    filters.push(parseFilter(filter[2]!, filter[3]!))
  }
  if (filters.length > PROFILE_MAX_FILTERS) throw new ProfileImportError('tooMany')
  // Brought inside the bounds connect holds every band to; a filter at
  // 0 dB does nothing and goes.
  const clean = sanitizeFilters(filters)
  if (clean.length === 0) throw new ProfileImportError('empty')
  return clean
}

/** "Sennheiser HD 600 ParametricEQ.txt" -> "Sennheiser HD 600". */
export function profileName(fileName: string): string {
  return (
    fileName
      .replace(/\.[^.]*$/, '')
      .replace(/[\s_-]*(parametric|fixedband)\s*eq$/i, '')
      .trim()
      .slice(0, PRESET_NAME_MAX_LENGTH) || fileName.slice(0, PRESET_NAME_MAX_LENGTH)
  )
}

export function importProfile(fileName: string, text: string): EqualizerProfile {
  return { name: profileName(fileName), filters: parseProfile(text) }
}
