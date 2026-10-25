/** The orders and filters the artist list offers, and the index-bar
 * sections each order files an artist under - the artist counterpart of
 * albumSort.ts. */

import { ALPHABET_SECTIONS, indexLetterFor } from '@/services/alphabetIndex'
import { accountScopedKey } from '@/services/accountKey'
import { RATING_SECTIONS, UNRATED_SECTION, ratingSection } from '@/services/ratingSort'
import {
  RATING_ORDER,
  rangeOf,
  rangeOrder,
  type FilterFieldDef,
  type Ranges,
} from '@/services/library/libraryFilter'
import type { Artist } from '@/types/library'

export type ArtistSortKey = 'name' | 'rating' | 'albumCount'

export interface ArtistSort {
  key: ArtistSortKey
  direction: 'asc' | 'desc'
}

export const ARTIST_SORT_KEYS: ArtistSortKey[] = ['name', 'rating', 'albumCount']

export function defaultArtistDirection(key: ArtistSortKey): 'asc' | 'desc' {
  return key === 'name' ? 'asc' : 'desc'
}

/** Name A-Z returns the server's own order untouched, for the same reason
 * as sortAlbums(). Equal figures keep that order too - the sort is stable.
 * An unrated artist goes last whichever way round. */
export function sortArtists(artists: Artist[], sort: ArtistSort): Artist[] {
  const dir = sort.direction === 'desc' ? -1 : 1
  if (sort.key === 'name') return dir === 1 ? artists : [...artists].reverse()
  if (sort.key === 'albumCount') {
    return [...artists].sort((a, b) => dir * (a.albumCount - b.albumCount))
  }
  return [...artists].sort((a, b) => {
    if (!a.rating || !b.rating) return (b.rating ? 1 : 0) - (a.rating ? 1 : 0)
    return dir * (a.rating - b.rating)
  })
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

export function artistSectionFor(artist: Artist, sort: ArtistSort): string {
  // indexLetterFor prefers the server's sort name - see its own comment on
  // why the display name's first letter can be the wrong section.
  if (sort.key === 'rating') return ratingSection(artist)
  if (sort.key === 'albumCount') return rangeOf(artist.albumCount, ALBUM_COUNT_RANGES)
  return indexLetterFor(artist)
}

/** The bar's entries in the order the list runs - see albumSort.ts's
 * sectionsFor(). */
export function artistSectionsFor(sortedArtists: Artist[], sort: ArtistSort): string[] {
  const ascending = sort.direction === 'asc'
  if (sort.key === 'name') return ascending ? ALPHABET_SECTIONS : [...ALPHABET_SECTIONS].reverse()
  if (sort.key === 'rating') {
    const stars = RATING_SECTIONS.filter((section) => section !== UNRATED_SECTION)
    return [...(ascending ? [...stars].reverse() : stars), UNRATED_SECTION]
  }
  return [...new Set(sortedArtists.map((artist) => artistSectionFor(artist, sort)))]
}

export const ARTIST_FILTER_FIELDS: FilterFieldDef<Artist>[] = [
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
]

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
