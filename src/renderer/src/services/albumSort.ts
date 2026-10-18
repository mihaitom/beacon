/** The orders the album list offers, and the index-bar sections each one
 * files an album under (see AlbumsView.vue and AlphabetIndexBar.vue). */

import { ALPHABET_SECTIONS, indexLetterFor, letterForName } from '@/services/alphabetIndex'
import { accountScopedKey } from '@/services/accountKey'
import type { Album } from '@/types/library'

export type AlbumSort = 'name' | 'artist' | 'year' | 'added'

export const ALBUM_SORTS: AlbumSort[] = ['name', 'artist', 'year', 'added']

/** The section an album without a year goes under in the year order. Last
 * in the bar, where the list puts those albums. */
export const UNKNOWN_YEAR_SECTION = '?'

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

function byName(a: Album, b: Album): number {
  return collator.compare(a.sortName || a.name, b.sortName || b.name)
}

/** Newest first: someone sorting a library by year is usually after what
 * came out lately, and the old records are one jump on the bar away. */
function byYear(a: Album, b: Album): number {
  if (a.year == null && b.year == null) return byName(a, b)
  if (a.year == null) return 1
  if (b.year == null) return -1
  return b.year - a.year || byName(a, b)
}

/** An artist's albums in the order they came out, the way a discography
 * reads. */
function byArtist(a: Album, b: Album): number {
  return (
    collator.compare(a.artist, b.artist) ||
    (a.year ?? Infinity) - (b.year ?? Infinity) ||
    byName(a, b)
  )
}

/** Newest addition first; an album the server gave no date for has no place
 * in that order and goes to the end. ISO 8601 strings sort as their dates. */
function byAdded(a: Album, b: Album): number {
  if (!a.created && !b.created) return byName(a, b)
  if (!a.created) return 1
  if (!b.created) return -1
  return b.created.localeCompare(a.created) || byName(a, b)
}

/** The list in the given order. Name returns the server's own order
 * untouched - it is already alphabetical by sort name (see fetchAlbums),
 * and re-sorting it here could only disagree with the server about where
 * an accented or numbered name goes. */
export function sortAlbums(albums: Album[], sort: AlbumSort): Album[] {
  switch (sort) {
    case 'name':
      return albums
    case 'artist':
      return [...albums].sort(byArtist)
    case 'year':
      return [...albums].sort(byYear)
    case 'added':
      return [...albums].sort(byAdded)
  }
}

/** The decade a year falls in, as the bar names it: 1987 -> "1980". */
function decadeOf(year: number): string {
  return String(Math.floor(year / 10) * 10)
}

/** The index-bar section an album sits in under the given order - empty for
 * "recently added", which has no sections to jump between. */
export function sectionFor(album: Album, sort: AlbumSort): string {
  switch (sort) {
    case 'name':
      return indexLetterFor(album)
    case 'artist':
      return letterForName(album.artist)
    case 'year':
      return album.year == null ? UNKNOWN_YEAR_SECTION : decadeOf(album.year)
    case 'added':
      return ''
  }
}

/** Every section the bar shows for the given order, in bar order, or none
 * for an order without sections. The alphabet is always whole, so the
 * letters stay in place while a filter greys some out; decades only span
 * the library's own, since a run of a hundred years nobody has music from
 * would push the real ones off the bar. */
export function sectionsFor(albums: Album[], sort: AlbumSort): string[] {
  if (sort === 'added') return []
  if (sort !== 'year') return ALPHABET_SECTIONS
  const years = albums.map((album) => album.year).filter((year): year is number => year != null)
  const sections: string[] = []
  if (years.length) {
    const newest = Math.floor(years.reduce((a, b) => Math.max(a, b)) / 10) * 10
    const oldest = Math.floor(years.reduce((a, b) => Math.min(a, b)) / 10) * 10
    for (let decade = newest; decade >= oldest; decade -= 10) sections.push(String(decade))
  }
  if (years.length < albums.length) sections.push(UNKNOWN_YEAR_SECTION)
  return sections
}

const STORAGE_KEY = 'beacon.albumSort'

/** Remembered per device, like the sidebar: how someone browses their
 * albums belongs to the window they browse in. */
export function loadAlbumSort(): AlbumSort {
  try {
    const stored = localStorage.getItem(accountScopedKey(STORAGE_KEY))
    return ALBUM_SORTS.includes(stored as AlbumSort) ? (stored as AlbumSort) : 'name'
  } catch {
    return 'name'
  }
}

export function saveAlbumSort(sort: AlbumSort): void {
  try {
    localStorage.setItem(accountScopedKey(STORAGE_KEY), sort)
  } catch {
    // Applies for this session only; not worth surfacing.
  }
}
