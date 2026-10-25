/** The orders and filters the artist list offers, and the index-bar
 * sections each order files an artist under - the artist counterpart of
 * albumSort.ts. Most of them read figures counted out of the song
 * catalogue (services/library/artistStats.ts), handed in as `statsOf`. */

import { ALPHABET_SECTIONS, indexLetterFor, letterForName } from '@/services/alphabetIndex'
import { accountScopedKey } from '@/services/accountKey'
import { RATING_SECTIONS, UNRATED_SECTION, ratingSection } from '@/services/ratingSort'
import {
  AGE_ORDER,
  RATING_ORDER,
  UNKNOWN_OPTION,
  ageOf,
  decadeOption,
  rangeOf,
  rangeOrder,
  type FilterField,
  type FilterFieldDef,
  type Ranges,
} from '@/services/library/libraryFilter'
import type { ArtistStats, ArtistStatsOf } from '@/services/library/artistStats'
import type { Artist } from '@/types/library'

export type ArtistSortKey =
  | 'name'
  | 'rating'
  | 'albumCount'
  | 'songCount'
  | 'genre'
  | 'years'
  | 'duration'
  | 'playCount'
  | 'lastPlayed'
  | 'added'

export interface ArtistSort {
  key: ArtistSortKey
  direction: 'asc' | 'desc'
}

export const ARTIST_SORT_KEYS: ArtistSortKey[] = [
  'name',
  'genre',
  'years',
  'albumCount',
  'songCount',
  'duration',
  'playCount',
  'lastPlayed',
  'added',
  'rating',
]

/** Words from the front, figures biggest (or latest) first. */
export function defaultArtistDirection(key: ArtistSortKey): 'asc' | 'desc' {
  return key === 'name' || key === 'genre' ? 'asc' : 'desc'
}

const noStats: ArtistStatsOf = () => null

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

function time(value: string | null | undefined): number | null {
  return value ? Date.parse(value) || null : null
}

/** What an order compares, or null where the artist has no value - those
 * go last whichever way round the order runs. */
const VALUE_OF: Record<
  Exclude<ArtistSortKey, 'name'>,
  (artist: Artist, stats: ArtistStats | null) => number | string | null
> = {
  rating: (artist) => artist.rating || null,
  albumCount: (artist) => artist.albumCount,
  songCount: (_, stats) => stats?.songCount ?? null,
  genre: (_, stats) => stats?.genre ?? null,
  years: (_, stats) => stats?.firstYear ?? null,
  duration: (_, stats) => stats?.duration ?? null,
  playCount: (_, stats) => stats?.playCount ?? null,
  lastPlayed: (_, stats) => time(stats?.lastPlayed),
  added: (_, stats) => time(stats?.added),
}

function compare(a: number | string, b: number | string): number {
  return typeof a === 'string' ? collator.compare(a, b as string) : a - (b as number)
}

/** Name A-Z returns the server's own order untouched, for the same reason
 * as sortAlbums(). Equal values keep that order too - the sort is stable. */
export function sortArtists(
  artists: Artist[],
  sort: ArtistSort,
  statsOf: ArtistStatsOf = noStats,
): Artist[] {
  const dir = sort.direction === 'desc' ? -1 : 1
  if (sort.key === 'name') return dir === 1 ? artists : [...artists].reverse()
  const valueOf = VALUE_OF[sort.key]
  return artists
    .map((artist) => ({ artist, value: valueOf(artist, statsOf(artist)) }))
    .sort((a, b) => {
      if (a.value === b.value) return 0
      if (a.value === null) return 1
      if (b.value === null) return -1
      return dir * compare(a.value, b.value)
    })
    .map(({ artist }) => artist)
}

/** One album, a handful, a long career. */
const ALBUM_COUNT_RANGES: Ranges = [
  ['1', 0],
  ['2-3', 2],
  ['4-5', 4],
  ['6-10', 6],
  ['11-20', 11],
  ['21+', 21],
]

/** A guest spot, an EP, an album or two, a catalogue. */
const SONG_COUNT_RANGES: Ranges = [
  ['1', 0],
  ['2-5', 2],
  ['6-10', 6],
  ['11-25', 11],
  ['26-50', 26],
  ['51-100', 51],
  ['101+', 101],
]

/** Hours. */
const HOUR_RANGES: Ranges = [
  ['<1', 0],
  ['1-2', 1],
  ['2-5', 2],
  ['5-10', 5],
  ['10-20', 10],
  ['20+', 20],
]

/** Every play of every song added up, so far more than one song's. */
const PLAY_COUNT_RANGES: Ranges = [
  ['0', 0],
  ['1-9', 1],
  ['10-49', 10],
  ['50-99', 50],
  ['100-249', 100],
  ['250-499', 250],
  ['500-999', 500],
  ['1000+', 1000],
]

const NEVER = 'never'

/** The filter field whose options name an order's sections - the divider
 * and the bar label them the way the filter menu does. Null for the
 * letters and stars, which name themselves. */
const SECTION_FIELD: Partial<Record<ArtistSortKey, FilterField>> = {
  albumCount: 'albumCount',
  songCount: 'songCount',
  years: 'year',
  duration: 'totalDuration',
  playCount: 'playCount',
  lastPlayed: 'lastPlayed',
  added: 'added',
}

export function artistSectionField(key: ArtistSortKey): FilterField | null {
  return SECTION_FIELD[key] ?? null
}

/** Each figure's option, shared by the sections and the filter menu so the
 * two always agree. */
const OPTION_OF = {
  songCount: (stats: ArtistStats | null) => rangeOf(stats?.songCount, SONG_COUNT_RANGES),
  genre: (stats: ArtistStats | null) => stats?.genre || UNKNOWN_OPTION,
  years: (stats: ArtistStats | null) => decadeOption(stats?.firstYear),
  duration: (stats: ArtistStats | null) =>
    stats ? rangeOf(stats.duration / 3600, HOUR_RANGES) : UNKNOWN_OPTION,
  playCount: (stats: ArtistStats | null) => rangeOf(stats?.playCount, PLAY_COUNT_RANGES),
  lastPlayed: (stats: ArtistStats | null, now: number) =>
    stats ? ageOf(stats.lastPlayed, now, NEVER) : UNKNOWN_OPTION,
  added: (stats: ArtistStats | null, now: number) => ageOf(stats?.added, now, UNKNOWN_OPTION),
}

export function artistSectionFor(
  artist: Artist,
  sort: ArtistSort,
  statsOf: ArtistStatsOf = noStats,
  now = Date.now(),
): string {
  // indexLetterFor prefers the server's sort name - see its own comment on
  // why the display name's first letter can be the wrong section.
  if (sort.key === 'name') return indexLetterFor(artist)
  if (sort.key === 'rating') return ratingSection(artist)
  if (sort.key === 'albumCount') return rangeOf(artist.albumCount, ALBUM_COUNT_RANGES)
  const stats = statsOf(artist)
  if (sort.key === 'genre') return stats?.genre ? letterForName(stats.genre) : UNKNOWN_OPTION
  return OPTION_OF[sort.key](stats, now)
}

/** The bar's entries in the order the list runs - see albumSort.ts's
 * sectionsFor(). */
export function artistSectionsFor(
  sortedArtists: Artist[],
  sort: ArtistSort,
  statsOf: ArtistStatsOf = noStats,
): string[] {
  const ascending = sort.direction === 'asc'
  if (sort.key === 'name') return ascending ? ALPHABET_SECTIONS : [...ALPHABET_SECTIONS].reverse()
  if (sort.key === 'rating') {
    const stars = RATING_SECTIONS.filter((section) => section !== UNRATED_SECTION)
    return [...(ascending ? [...stars].reverse() : stars), UNRATED_SECTION]
  }
  const now = Date.now()
  return [...new Set(sortedArtists.map((artist) => artistSectionFor(artist, sort, statsOf, now)))]
}

export function artistFilterFields(statsOf: ArtistStatsOf = noStats): FilterFieldDef<Artist>[] {
  return [
    {
      field: 'genre',
      labelKey: 'library.genre',
      optionOf: (artist) => OPTION_OF.genre(statsOf(artist)),
    },
    {
      field: 'year',
      labelKey: 'library.artistYears',
      optionOf: (artist) => OPTION_OF.years(statsOf(artist)),
    },
    {
      field: 'rating',
      labelKey: 'library.rating',
      optionOf: (artist) => String(artist.rating ?? 0),
      order: RATING_ORDER,
    },
    {
      field: 'starred',
      labelKey: 'library.songFilter.starred',
      optionOf: (artist) => (artist.starred ? 'yes' : 'no'),
      order: ['yes', 'no'],
    },
    {
      field: 'albumCount',
      labelKey: 'library.albums',
      optionOf: (artist) => rangeOf(artist.albumCount, ALBUM_COUNT_RANGES),
      order: rangeOrder(ALBUM_COUNT_RANGES),
    },
    {
      field: 'songCount',
      labelKey: 'library.songs',
      optionOf: (artist) => OPTION_OF.songCount(statsOf(artist)),
      order: [...rangeOrder(SONG_COUNT_RANGES), UNKNOWN_OPTION],
    },
    {
      field: 'totalDuration',
      labelKey: 'library.duration',
      optionOf: (artist) => OPTION_OF.duration(statsOf(artist)),
      order: [...rangeOrder(HOUR_RANGES), UNKNOWN_OPTION],
    },
    {
      field: 'playCount',
      labelKey: 'library.plays',
      optionOf: (artist) => OPTION_OF.playCount(statsOf(artist)),
      order: [...rangeOrder(PLAY_COUNT_RANGES), UNKNOWN_OPTION],
    },
    {
      field: 'lastPlayed',
      labelKey: 'library.lastPlayed',
      optionOf: (artist, now) => OPTION_OF.lastPlayed(statsOf(artist), now),
      order: [...AGE_ORDER, NEVER, UNKNOWN_OPTION],
    },
    {
      field: 'added',
      labelKey: 'library.songFilter.added',
      optionOf: (artist, now) => OPTION_OF.added(statsOf(artist), now),
      order: [...AGE_ORDER, UNKNOWN_OPTION],
    },
  ]
}

const STORAGE_KEY = 'beacon.artistSort'

/** Remembered per device - see loadAlbumSort(). */
export function loadArtistSort(): ArtistSort {
  try {
    const stored = localStorage.getItem(accountScopedKey(STORAGE_KEY)) ?? ''
    if (ARTIST_SORT_KEYS.includes(stored as ArtistSortKey)) {
      const key = stored as ArtistSortKey
      return { key, direction: defaultArtistDirection(key) }
    }
    const parsed = JSON.parse(stored) as ArtistSort
    if (ARTIST_SORT_KEYS.includes(parsed.key) && ['asc', 'desc'].includes(parsed.direction)) {
      return parsed
    }
  } catch {
    // Falls through to the default.
  }
  return { key: 'name', direction: 'asc' }
}

export function saveArtistSort(sort: ArtistSort): void {
  try {
    localStorage.setItem(accountScopedKey(STORAGE_KEY), JSON.stringify(sort))
  } catch {
    // Applies for this session only; not worth surfacing.
  }
}
