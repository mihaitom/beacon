/** The orders and filters SongsView offers over the whole library. */

import { accountScopedKey } from '@/services/accountKey'
import { ALPHABET_SECTIONS, letterForName } from '@/services/alphabetIndex'
import { RATING_SECTIONS, ratingSection } from '@/services/ratingSort'
import {
  AGE_ORDER,
  RATING_ORDER,
  UNKNOWN_OPTION,
  ageOf,
  decadeOf,
  decadeOption,
  filterItems,
  rangeOf,
  rangeOrder,
  type FilterFieldDef,
  type LibraryFilters,
  type Ranges,
} from '@/services/library/libraryFilter'
import {
  SONG_COLUMNS,
  songColumn,
  songColumnAvailable,
  type SongColumnKey,
} from '@/services/library/songColumns'
import type { ServerType } from '@/services/capabilities'
import type { Song } from '@/types/library'

/** Every column's order, plus the artist, which has no column of its own -
 * it is the second line of the title cell. */
export type SongSortKey = SongColumnKey | 'artist'

export interface SongSort {
  key: SongSortKey
  direction: 'asc' | 'desc'
}

/** Where picking an order starts: figures biggest first, since someone
 * sorting by plays or by year is after the most played or the newest. Words
 * and the position on a release run from the front. */
const STARTS_DESCENDING = new Set<SongSortKey>([
  'year',
  'bpm',
  'added',
  'lastPlayed',
  'playCount',
  'format',
  'sampleRate',
  'size',
  'rating',
])

export function defaultDirection(key: SongSortKey): 'asc' | 'desc' {
  return STARTS_DESCENDING.has(key) ? 'desc' : 'asc'
}

/** The orders this server's songs can be put in, in the table's column
 * order with the artist after the title. A column the server sends no data
 * for has nothing to sort by. */
export function sortKeysFor(serverType: ServerType | null): SongSortKey[] {
  const keys: SongSortKey[] = []
  for (const column of SONG_COLUMNS) {
    if (!column.sortValue || !songColumnAvailable(column, serverType)) continue
    keys.push(column.key)
    if (column.key === 'title') keys.push('artist')
  }
  return keys
}

export function sortLabelKey(key: SongSortKey): string {
  return key === 'artist' ? 'library.artist' : (songColumn(key)?.labelKey ?? '')
}

/** What songColumns' sortValue answers for a date or a gain the server
 * left out: last in either direction, not first once the order is turned
 * round. */
const UNSET = Number.MAX_SAFE_INTEGER

function valueOf(song: Song, key: SongSortKey): string | number {
  if (key === 'artist') return song.artist.toLowerCase()
  return songColumn(key)?.sortValue?.(song) ?? 0
}

/** Equal values are put in a useful order instead of the server's: an
 * artist's songs by album and track, a year's by artist and album. */
const THEN_BY: Partial<Record<SongSortKey, SongSortKey[]>> = {
  title: ['artist'],
  artist: ['album', 'disc', 'track'],
  album: ['artist', 'disc', 'track'],
}
const THEN_BY_DEFAULT: SongSortKey[] = ['artist', 'album', 'disc', 'track']

function compareValues(a: string | number, b: string | number, dir: number): number {
  if (a === b) return 0
  if (a === UNSET) return 1
  if (b === UNSET) return -1
  return (a < b ? -1 : 1) * dir
}

/** Each song's values are read once up front: a comparison reads them about
 * thirty times per song in a library of 20,000. */
export function sortSongs(songs: Song[], sort: SongSort): Song[] {
  const keys = [sort.key, ...(THEN_BY[sort.key] ?? THEN_BY_DEFAULT)]
  const dir = sort.direction === 'desc' ? -1 : 1
  return songs
    .map((song) => ({ song, values: keys.map((key) => valueOf(song, key)) }))
    .sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const result = compareValues(a.values[i]!, b.values[i]!, i === 0 ? dir : 1)
        if (result) return result
      }
      return 0
    })
    .map(({ song }) => song)
}

const SORT_STORAGE_KEY = 'beacon.songSort'

export function loadSongSort(): SongSort {
  try {
    const stored = JSON.parse(localStorage.getItem(accountScopedKey(SORT_STORAGE_KEY)) ?? 'null')
    if (stored?.key && (stored.direction === 'asc' || stored.direction === 'desc')) return stored
  } catch {
    // Falls through to the default.
  }
  return { key: 'title', direction: 'asc' }
}

export function saveSongSort(sort: SongSort): void {
  try {
    localStorage.setItem(accountScopedKey(SORT_STORAGE_KEY), JSON.stringify(sort))
  } catch {
    // Applies for this session only; not worth surfacing.
  }
}

/** The section a song without a year goes under. */
export const UNKNOWN_YEAR_SECTION = UNKNOWN_OPTION

/** The orders that come in sections, with what files a song under one.
 * The rest have nothing a reader would jump between. */
const SECTION_OF: Partial<Record<SongSortKey, (song: Song) => string>> = {
  title: (song) => letterForName(song.title),
  artist: (song) => letterForName(song.artist),
  album: (song) => letterForName(song.album),
  genre: (song) => letterForName(song.genre ?? ''),
  year: (song) => decadeOption(song.year),
  rating: (song) => ratingSection(song),
}

/** The orders whose sections are the filter menu's ranges. Not the format:
 * that column sorts by bitrate, which the suffixes do not follow. */
const RANGE_SECTIONED = new Set<SongSortKey>([
  'bpm',
  'duration',
  'playCount',
  'lastPlayed',
  'added',
  'sampleRate',
])

export function isRangeSectioned(key: SongSortKey): boolean {
  return RANGE_SECTIONED.has(key)
}

export function sectionFn(key: SongSortKey, now = Date.now()): ((song: Song) => string) | null {
  if (SECTION_OF[key]) return SECTION_OF[key]
  const def = RANGE_SECTIONED.has(key) ? FILTER_FIELDS.find((field) => field.field === key) : null
  return def ? (song) => def.optionOf(song, now) : null
}

/** The index bar's entries for this order, in the order the list runs. The
 * alphabet stays whole so letters keep their place while a filter greys
 * some out; decades only span the library's own. A range order lists the
 * ranges as the sorted list meets them, which also puts the songs without
 * a value wherever the order put them. */
export function sectionsFor(sortedSongs: Song[], sort: SongSort): string[] {
  const songs = sortedSongs
  if (RANGE_SECTIONED.has(sort.key)) {
    const section = sectionFn(sort.key)!
    return [...new Set(sortedSongs.map(section))]
  }
  let sections: string[]
  if (sort.key === 'rating') sections = RATING_SECTIONS
  else if (sort.key === 'year') {
    sections = decadesIn(songs).map(String)
    if (songs.some((song) => !song.year)) sections.push(UNKNOWN_YEAR_SECTION)
  } else if (SECTION_OF[sort.key]) sections = ALPHABET_SECTIONS
  else return []
  // Both the decades and the stars are listed biggest first.
  const listedAscending = sort.key !== 'year' && sort.key !== 'rating'
  return listedAscending === (sort.direction === 'asc') ? sections : [...sections].reverse()
}

/** Tens of BPM: a step a DJ would still call the same tempo. */
const BPM_RANGES: Ranges = [
  ['<70', 0],
  ...Array.from({ length: 11 }, (_, i): [string, number] => {
    const from = 70 + i * 10
    return [`${from}-${from + 9}`, from]
  }),
  ['180+', 180],
]

/** Minutes, counted in seconds. A minute apart where most songs sit, wider
 * past that, where a minute no longer tells two songs apart. */
const DURATION_RANGES: Ranges = [
  ['<1', 0],
  ['1-2', 60],
  ['2-3', 120],
  ['3-4', 180],
  ['4-5', 240],
  ['5-6', 300],
  ['6-8', 360],
  ['8-10', 480],
  ['10-15', 600],
  ['15-20', 900],
  ['20+', 1200],
]

const PLAY_COUNT_RANGES: Ranges = [
  ['0', 0],
  ['1', 1],
  ['2-4', 2],
  ['5-9', 5],
  ['10-19', 10],
  ['20-49', 20],
  ['50-99', 50],
  ['100+', 100],
]

export interface SongFilterFieldDef extends FilterFieldDef<Song> {
  /** The column whose data this is - the field is only offered where the
   * server sends it. Null for one every server answers. */
  column: SongColumnKey | null
}

function columnField(
  column: SongColumnKey,
  def: Omit<SongFilterFieldDef, 'column' | 'labelKey'>,
): SongFilterFieldDef {
  return { ...def, column, labelKey: songColumn(column)?.labelKey ?? '' }
}

export const FILTER_FIELDS: SongFilterFieldDef[] = [
  columnField('genre', { field: 'genre', optionOf: (song) => song.genre || UNKNOWN_OPTION }),
  columnField('year', { field: 'year', optionOf: (song) => decadeOption(song.year) }),
  columnField('rating', {
    field: 'rating',
    optionOf: (song) => String(song.rating ?? 0),
    order: RATING_ORDER,
  }),
  {
    field: 'starred',
    column: null,
    labelKey: 'library.songFilter.starred',
    optionOf: (song) => (song.starred ? 'yes' : 'no'),
    order: ['yes', 'no'],
  },
  columnField('bpm', {
    field: 'bpm',
    // A tag of 0 is how a file says it was never measured.
    optionOf: (song) => rangeOf(song.bpm || null, BPM_RANGES),
    order: [...rangeOrder(BPM_RANGES), UNKNOWN_OPTION],
  }),
  columnField('duration', {
    field: 'duration',
    optionOf: (song) => rangeOf(song.duration, DURATION_RANGES),
    order: rangeOrder(DURATION_RANGES),
  }),
  columnField('playCount', {
    field: 'playCount',
    optionOf: (song) => rangeOf(song.playCount ?? 0, PLAY_COUNT_RANGES),
    order: rangeOrder(PLAY_COUNT_RANGES),
  }),
  columnField('lastPlayed', {
    field: 'lastPlayed',
    optionOf: (song, now) => ageOf(song.lastPlayed, now, 'never'),
    order: [...AGE_ORDER, 'never'],
  }),
  columnField('added', {
    field: 'added',
    optionOf: (song, now) => ageOf(song.added, now, UNKNOWN_OPTION),
    order: [...AGE_ORDER, UNKNOWN_OPTION],
  }),
  columnField('format', {
    field: 'format',
    optionOf: (song) => song.format?.toLowerCase() || UNKNOWN_OPTION,
  }),
  columnField('sampleRate', {
    field: 'sampleRate',
    optionOf: (song) => (song.sampleRate ? String(song.sampleRate) : UNKNOWN_OPTION),
  }),
]

export function filterFieldsFor(serverType: ServerType | null): SongFilterFieldDef[] {
  return FILTER_FIELDS.filter((def) => {
    const column = def.column ? songColumn(def.column) : null
    return !column || songColumnAvailable(column, serverType)
  })
}

export function filterSongs(songs: Song[], filters: LibraryFilters, now = Date.now()): Song[] {
  return filterItems(songs, FILTER_FIELDS, filters, now)
}

/** Every decade with at least one song, newest first. */
export function decadesIn(songs: Song[]): number[] {
  const decades = new Set<number>()
  for (const song of songs) if (song.year) decades.add(decadeOf(song.year))
  return [...decades].sort((a, b) => b - a)
}
