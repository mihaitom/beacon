/** The orders and groups the desktop Radio page offers (RadioView.vue). */

import { accountScopedKey } from '@/services/accountKey'
import type { RadioStationInfo } from '@/services/connect/radio'
import type { RadioStation } from '@/types/library'

export type RadioSortKey = 'heard' | 'name' | 'country' | 'bitrate'

export interface RadioSort {
  key: RadioSortKey
  direction: 'asc' | 'desc'
}

export type StationInfoLookup = (station: RadioStation) => RadioStationInfo | null

export const RADIO_SORT_KEYS: RadioSortKey[] = ['heard', 'name', 'country', 'bitrate']

const STORAGE_KEY = 'beacon.radioSort'
const DEFAULT_SORT: RadioSort = { key: 'heard', direction: 'desc' }
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const MAX_TAG_SEGMENTS = 5
// A tag only one station has narrows the wall to that one station.
const MIN_STATIONS_PER_TAG = 2

/** Names and countries from the front; the latest and the highest first. */
export function defaultRadioDirection(key: RadioSortKey): 'asc' | 'desc' {
  return key === 'name' || key === 'country' ? 'asc' : 'desc'
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Null where a station has no usable value, which the sort puts last. */
function sortValue(info: RadioStationInfo | null, key: RadioSortKey): number | string | null {
  if (key === 'heard') return info?.lastTitle?.at ?? null
  if (key === 'bitrate') return info?.bitrate || null
  return info?.country || null
}

export function sortStations(
  stations: RadioStation[],
  sort: RadioSort,
  infoFor: StationInfoLookup,
): RadioStation[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  const byName = (a: RadioStation, b: RadioStation) => collator.compare(a.name, b.name)
  const compare = (first: number | string, second: number | string) =>
    typeof first === 'number' && typeof second === 'number'
      ? first - second
      : collator.compare(String(first), String(second))
  return [...stations].sort((a, b) => {
    if (sort.key === 'name') return sign * byName(a, b)
    const first = sortValue(infoFor(a), sort.key)
    const second = sortValue(infoFor(b), sort.key)
    if (first === null || second === null) {
      // Last whichever way round the order runs.
      if (first !== second) return first === null ? 1 : -1
      return byName(a, b)
    }
    return sign * compare(first, second) || byName(a, b)
  })
}

/** The tags worth a button: the most common ones, ties in the order they
 * first appeared. */
export function commonTags(stations: RadioStation[], infoFor: StationInfoLookup): string[] {
  const counts = new Map<string, number>()
  for (const station of stations) {
    for (const tag of new Set(infoFor(station)?.tags ?? [])) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= MIN_STATIONS_PER_TAG)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TAG_SEGMENTS)
    .map(([tag]) => tag)
}

export function hasTag(station: RadioStation, tag: string, infoFor: StationInfoLookup): boolean {
  return infoFor(station)?.tags?.includes(tag) ?? false
}

export interface StationSections {
  heardThisWeek: RadioStation[]
  earlier: RadioStation[]
}

export function heardSections(
  stations: RadioStation[],
  infoFor: StationInfoLookup,
  now: number,
): StationSections {
  const heardThisWeek = (station: RadioStation) => {
    const at = infoFor(station)?.lastTitle?.at
    return at !== undefined && now - at * 1000 <= WEEK_MS
  }
  return {
    heardThisWeek: stations.filter(heardThisWeek),
    earlier: stations.filter((station) => !heardThisWeek(station)),
  }
}

export function loadRadioSort(): RadioSort {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(accountScopedKey(STORAGE_KEY)) ?? '',
    ) as RadioSort
    if (RADIO_SORT_KEYS.includes(parsed.key) && ['asc', 'desc'].includes(parsed.direction)) {
      return parsed
    }
  } catch {
    // Falls through to the default.
  }
  return DEFAULT_SORT
}

export function saveRadioSort(sort: RadioSort): void {
  try {
    localStorage.setItem(accountScopedKey(STORAGE_KEY), JSON.stringify(sort))
  } catch {
    // Applies for this session only; not worth surfacing.
  }
}
