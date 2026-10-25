/** The orders and filters the album list offers, and the index-bar sections
 * each order files an album under (see AlbumsView.vue and
 * AlphabetIndexBar.vue). */

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
import type { Album } from '@/types/library'

export type AlbumSortKey =
  'name' | 'artist' | 'year' | 'added' | 'rating' | 'songCount' | 'duration'

export interface AlbumSort {
  key: AlbumSortKey
  direction: 'asc' | 'desc'
}

/** 'rating' is only offered where the server has a 1-5 scale - see
 * AlbumsView.vue's sortItems. */
export const ALBUM_SORT_KEYS: AlbumSortKey[] = [
  'name',
  'artist',
  'year',
  'added',
  'rating',
  'songCount',
  'duration',
]

/** Names from the front; figures biggest first - someone sorting by year is
 * usually after what came out lately, and the old records are one jump on
 * the bar away. */
export function defaultAlbumDirection(key: AlbumSortKey): 'asc' | 'desc' {
  return key === 'name' || key === 'artist' ? 'asc' : 'desc'
}

/** The section an album without a year goes under. Last in the bar, where
 * the list puts those albums. */
export const UNKNOWN_YEAR_SECTION = UNKNOWN_OPTION

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

function byName(a: Album, b: Album): number {
  return collator.compare(a.sortName || a.name, b.sortName || b.name)
}

/** What an order compares, or null where the album has no value - those go
 * last whichever way round the order runs. A rating of 0 is no rating. */
const VALUE_OF: Record<
  Exclude<AlbumSortKey, 'name' | 'artist'>,
  (album: Album) => number | null
> = {
  year: (album) => album.year ?? null,
  added: (album) => (album.created ? Date.parse(album.created) || null : null),
  rating: (album) => album.rating || null,
  songCount: (album) => album.songCount,
  duration: (album) => album.duration,
}

/** The list in the given order. Name A-Z returns the server's own order
 * untouched - it is already alphabetical by sort name (see fetchAlbums),
 * and re-sorting it here could only disagree with the server about where
 * an accented or numbered name goes. */
export function sortAlbums(albums: Album[], sort: AlbumSort): Album[] {
  const dir = sort.direction === 'desc' ? -1 : 1
  if (sort.key === 'name') return dir === 1 ? albums : [...albums].reverse()
  if (sort.key === 'artist') {
    // An artist's albums in the order they came out, the way a discography
    // reads, whichever way round the artists run.
    return [...albums].sort(
      (a, b) =>
        dir * collator.compare(a.artist, b.artist) ||
        (a.year ?? Infinity) - (b.year ?? Infinity) ||
        byName(a, b),
    )
  }
  const valueOf = VALUE_OF[sort.key]
  return [...albums].sort((a, b) => {
    const av = valueOf(a)
    const bv = valueOf(b)
    if (av === bv) return byName(a, b)
    if (av === null) return 1
    if (bv === null) return -1
    return dir * (av - bv) || byName(a, b)
  })
}

/** Albums by their number of songs: singles and EPs, then albums of about
 * the usual length, then the long ones. */
const SONG_COUNT_RANGES: Ranges = [
  ['1-3', 0],
  ['4-7', 4],
  ['8-10', 8],
  ['11-13', 11],
  ['14-16', 14],
  ['17-20', 17],
  ['21+', 21],
]

/** Minutes, counted in seconds: an LP side, an LP, a CD, a double album. */
const DURATION_RANGES: Ranges = [
  ['<15', 0],
  ['15-30', 900],
  ['30-40', 1800],
  ['40-50', 2400],
  ['50-60', 3000],
  ['60-80', 3600],
  ['80+', 4800],
]

/** The orders whose sections are the filter menu's ranges, by the filter
 * field that names them. */
const RANGE_FIELD: Partial<Record<AlbumSortKey, FilterField>> = {
  added: 'added',
  songCount: 'songCount',
  duration: 'duration',
}

export function albumRangeField(key: AlbumSortKey): FilterField | null {
  return RANGE_FIELD[key] ?? null
}

/** The index-bar section an album sits in under the given order. */
export function sectionFor(album: Album, sort: AlbumSort, now = Date.now()): string {
  switch (sort.key) {
    case 'name':
      return indexLetterFor(album)
    case 'artist':
      return letterForName(album.artist)
    case 'year':
      return decadeOption(album.year)
    case 'rating':
      return ratingSection(album)
    case 'added':
      return ageOf(album.created, now, UNKNOWN_OPTION)
    case 'songCount':
      return rangeOf(album.songCount, SONG_COUNT_RANGES)
    case 'duration':
      return rangeOf(album.duration, DURATION_RANGES)
  }
}

/** Every section the bar shows for the given order, in the order the list
 * runs. The alphabet is always whole, so the letters stay in place while a
 * filter greys some out; decades only span the library's own, since a run
 * of a hundred years nobody has music from would push the real ones off
 * the bar. The ranges are listed as the sorted list meets them. Albums
 * without a value stay last either way round. */
export function sectionsFor(sortedAlbums: Album[], sort: AlbumSort): string[] {
  const ascending = sort.direction === 'asc'
  if (sort.key === 'name' || sort.key === 'artist') {
    return ascending ? ALPHABET_SECTIONS : [...ALPHABET_SECTIONS].reverse()
  }
  if (sort.key === 'rating') {
    const stars = RATING_SECTIONS.filter((section) => section !== UNRATED_SECTION)
    return [...(ascending ? [...stars].reverse() : stars), UNRATED_SECTION]
  }
  if (sort.key === 'year') {
    const years = sortedAlbums.map((album) => album.year).filter((year) => year != null)
    const sections: string[] = []
    if (years.length) {
      const newest = Math.floor(Math.max(...years) / 10) * 10
      const oldest = Math.floor(Math.min(...years) / 10) * 10
      for (let decade = newest; decade >= oldest; decade -= 10) sections.push(String(decade))
    }
    if (ascending) sections.reverse()
    if (years.length < sortedAlbums.length) sections.push(UNKNOWN_YEAR_SECTION)
    return sections
  }
  const now = Date.now()
  return [...new Set(sortedAlbums.map((album) => sectionFor(album, sort, now)))]
}

export const ALBUM_FILTER_FIELDS: FilterFieldDef<Album>[] = [
  { field: 'genre', labelKey: 'library.genre', optionOf: (album) => album.genre || UNKNOWN_OPTION },
  { field: 'year', labelKey: 'library.year', optionOf: (album) => decadeOption(album.year) },
  {
    field: 'releaseType',
    labelKey: 'library.songFilter.releaseType',
    // The first type is the main one ("album" of "album, compilation").
    optionOf: (album) => album.releaseTypes?.[0] || UNKNOWN_OPTION,
  },
  {
    field: 'rating',
    labelKey: 'library.rating',
    optionOf: (album) => String(album.rating ?? 0),
    order: RATING_ORDER,
  },
  {
    field: 'starred',
    labelKey: 'library.songFilter.starred',
    optionOf: (album) => (album.starred ? 'yes' : 'no'),
    order: ['yes', 'no'],
  },
  {
    field: 'songCount',
    labelKey: 'library.songs',
    optionOf: (album) => rangeOf(album.songCount, SONG_COUNT_RANGES),
    order: rangeOrder(SONG_COUNT_RANGES),
  },
  {
    field: 'duration',
    labelKey: 'library.duration',
    optionOf: (album) => rangeOf(album.duration, DURATION_RANGES),
    order: rangeOrder(DURATION_RANGES),
  },
  {
    field: 'added',
    labelKey: 'library.songFilter.added',
    optionOf: (album, now) => ageOf(album.created, now, UNKNOWN_OPTION),
    order: [...AGE_ORDER, UNKNOWN_OPTION],
  },
]

const STORAGE_KEY = 'beacon.albumSort'

/** Remembered per device, like the sidebar: how someone browses their
 * albums belongs to the window they browse in. An order saved by an
 * earlier version is a bare key, read with its usual direction. */
export function loadAlbumSort(): AlbumSort {
  try {
    const stored = localStorage.getItem(accountScopedKey(STORAGE_KEY)) ?? ''
    if (ALBUM_SORT_KEYS.includes(stored as AlbumSort['key'])) {
      const key = stored as AlbumSortKey
      return { key, direction: defaultAlbumDirection(key) }
    }
    const parsed = JSON.parse(stored) as AlbumSort
    if (ALBUM_SORT_KEYS.includes(parsed.key) && ['asc', 'desc'].includes(parsed.direction)) {
      return parsed
    }
  } catch {
    // Falls through to the default.
  }
  return { key: 'name', direction: 'asc' }
}

export function saveAlbumSort(sort: AlbumSort): void {
  try {
    localStorage.setItem(accountScopedKey(STORAGE_KEY), JSON.stringify(sort))
  } catch {
    // Applies for this session only; not worth surfacing.
  }
}
