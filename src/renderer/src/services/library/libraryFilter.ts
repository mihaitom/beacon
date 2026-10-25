/** The filter menu every library list shares (songs, albums, artists): its
 * fields, the ranges they are cut into, and how an option is named. */

import { ratingSectionLabel } from '@/services/ratingSort'
import { formatSampleRate } from '@/services/library/songFormat'

/** Every field any list filters by. Each one files an item under exactly
 * one of its options, so a menu can count them in one pass, and picking
 * several options of one field means any of them. */
export type FilterField =
  | 'genre'
  | 'year'
  | 'rating'
  | 'starred'
  | 'bpm'
  | 'duration'
  | 'playCount'
  | 'lastPlayed'
  | 'added'
  | 'format'
  | 'sampleRate'
  | 'songCount'
  | 'albumCount'
  | 'releaseType'
  // An artist's songs added up, in hours (a song's or album's is 'duration').
  | 'totalDuration'

/** The options picked per field. A field with none picked lets
 * everything through. */
export type LibraryFilters = Partial<Record<FilterField, string[]>>

export interface FilterFieldDef<T> {
  field: FilterField
  labelKey: string
  optionOf: (item: T, now: number) => string
  /** The options in menu order. Left out for the fields whose options are
   * whatever the library holds, which list biggest first. */
  order?: string[]
}

/** The option for an item the server sent no value for. */
export const UNKNOWN_OPTION = '?'

const DAY_MS = 24 * 60 * 60 * 1000

/** Ranges as [option, lower bound inclusive], the last one open-ended. */
export type Ranges = [string, number][]

export function rangeOf(value: number | null | undefined, ranges: Ranges): string {
  if (value == null) return UNKNOWN_OPTION
  let option = ranges[0]![0]
  for (const [candidate, from] of ranges) if (value >= from) option = candidate
  return option
}

export function rangeOrder(ranges: Ranges): string[] {
  return ranges.map(([option]) => option)
}

/** How long ago, as [option, up to this many days]. Past the last one is
 * 'older'. */
const AGE_STEPS: [string, number][] = [
  ['d7', 7],
  ['d30', 30],
  ['m3', 91],
  ['m12', 365],
  ['y3', 1096],
]
export const AGE_ORDER = [...AGE_STEPS.map(([option]) => option), 'older']

export function ageOf(value: string | null | undefined, now: number, never: string): string {
  const time = value ? Date.parse(value) : NaN
  if (Number.isNaN(time)) return never
  const days = (now - time) / DAY_MS
  return AGE_STEPS.find(([, upTo]) => days <= upTo)?.[0] ?? 'older'
}

export function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10
}

export function decadeOption(year: number | null | undefined): string {
  return year ? String(decadeOf(year)) : UNKNOWN_OPTION
}

export const RATING_ORDER = ['5', '4', '3', '2', '1', '0']

export function activeFilterCount(filters: LibraryFilters): number {
  return Object.values(filters).filter((options) => options?.length).length
}

export function filterItems<T>(
  items: T[],
  fields: FilterFieldDef<T>[],
  filters: LibraryFilters,
  now = Date.now(),
): T[] {
  const active = fields
    .filter((def) => filters[def.field]?.length)
    .map((def) => [def, new Set(filters[def.field])] as const)
  if (!active.length) return items
  return items.filter((item) =>
    active.every(([def, picked]) => picked.has(def.optionOf(item, now))),
  )
}

/** A field's options with how many items each holds, in menu order. An
 * option nothing falls under is left out, unless the field has a fixed
 * order - an empty "5 stars" still says what the scale is. */
export function filterOptions<T>(
  items: T[],
  def: FilterFieldDef<T>,
  now = Date.now(),
): { option: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    const option = def.optionOf(item, now)
    counts.set(option, (counts.get(option) ?? 0) + 1)
  }
  if (def.order) {
    return def.order
      .filter((option) => option !== UNKNOWN_OPTION || counts.has(option))
      .map((option) => ({ option, count: counts.get(option) ?? 0 }))
  }
  const listed = [...counts]
    .filter(([option]) => option !== UNKNOWN_OPTION)
    .map(([option, count]) => ({ option, count }))
  if (def.field === 'year' || def.field === 'sampleRate') {
    // Newest decade first; sample rates low to high, the way they read.
    const sign = def.field === 'year' ? -1 : 1
    listed.sort((a, b) => sign * (Number(a.option) - Number(b.option)))
  } else {
    listed.sort((a, b) => b.count - a.count || a.option.localeCompare(b.option))
  }
  if (counts.has(UNKNOWN_OPTION)) {
    listed.push({ option: UNKNOWN_OPTION, count: counts.get(UNKNOWN_OPTION)! })
  }
  return listed
}

type Translate = (key: string, named?: Record<string, unknown>) => string

/** "90-99" reads as 90–99, "<70" as < 70, "180+" as ≥ 180. */
function rangeLabel(option: string): string {
  if (option.startsWith('<')) return `< ${option.slice(1)}`
  if (option.endsWith('+')) return `≥ ${option.slice(0, -1)}`
  return option.replace('-', '–')
}

/** An option as the filter menu and a section heading name it. */
export function filterOptionLabel(field: FilterField, option: string, t: Translate): string {
  if (option === UNKNOWN_OPTION) {
    return t(field === 'year' ? 'library.unknownYear' : 'library.songFilter.unknown')
  }
  switch (field) {
    case 'year':
      return t('library.decade', { decade: option })
    case 'rating':
      return ratingSectionLabel(option, t)
    case 'starred':
      return t(`library.songFilter.starred_${option}`)
    case 'lastPlayed':
    case 'added':
      return t(`library.songFilter.age.${option}`)
    case 'format':
      return option.toUpperCase()
    case 'sampleRate':
      return formatSampleRate(Number(option)) ?? option
    case 'releaseType': {
      // The same words the album page's eyebrow uses; a type the app has
      // none for is shown as the server spells it.
      const key = `library.releaseTypes.${option.replace(/-/g, '')}`
      const label = t(key)
      return label === key ? option.charAt(0).toUpperCase() + option.slice(1) : label
    }
    case 'duration':
      return `${rangeLabel(option)} min`
    case 'totalDuration':
      return `${rangeLabel(option)} h`
    case 'bpm':
    case 'playCount':
    case 'songCount':
    case 'albumCount':
      return rangeLabel(option)
    default:
      return option
  }
}

/** The same option in the few characters the index bar has room for. */
export function filterOptionShortLabel(field: FilterField, option: string, t: Translate): string {
  if (option === UNKNOWN_OPTION) return option
  // A range by where it starts; the open ends keep their sign.
  const start = (value: string) => (/^[<\d]/.test(value) ? value.split('-')[0]! : value)
  switch (field) {
    case 'lastPlayed':
    case 'added':
      return option === 'never' ? '–' : t(`library.songFilter.ageShort.${option}`)
    case 'sampleRate':
      return String(Number(option) / 1000)
    case 'duration':
      return `${start(option)}′`
    case 'totalDuration':
      return `${start(option)}h`
    case 'bpm':
    case 'playCount':
    case 'songCount':
    case 'albumCount':
      return start(option)
    default:
      return option
  }
}
