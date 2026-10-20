/** The orders the artist list offers, and the index-bar sections each one
 * files an artist under - the artist counterpart of albumSort.ts. */

import { ALPHABET_SECTIONS, indexLetterFor } from '@/services/alphabetIndex'
import { accountScopedKey } from '@/services/accountKey'
import { RATING_SECTIONS, ratingSection, sortByRating } from '@/services/ratingSort'
import type { Artist } from '@/types/library'

export type ArtistSort = 'name' | 'rating'

export const ARTIST_SORTS: ArtistSort[] = ['name', 'rating']

/** Name returns the server's own order untouched, for the same reason as
 * sortAlbums(). */
export function sortArtists(artists: Artist[], sort: ArtistSort): Artist[] {
  return sort === 'rating' ? sortByRating(artists) : artists
}

export function artistSectionFor(artist: Artist, sort: ArtistSort): string {
  // indexLetterFor prefers the server's sort name - see its own comment on
  // why the display name's first letter can be the wrong section.
  return sort === 'rating' ? ratingSection(artist) : indexLetterFor(artist)
}

export function artistSectionsFor(sort: ArtistSort): string[] {
  return sort === 'rating' ? RATING_SECTIONS : ALPHABET_SECTIONS
}

const STORAGE_KEY = 'beacon.artistSort'

/** Remembered per device - see loadAlbumSort(). */
export function loadArtistSort(): ArtistSort {
  try {
    const stored = localStorage.getItem(accountScopedKey(STORAGE_KEY))
    return ARTIST_SORTS.includes(stored as ArtistSort) ? (stored as ArtistSort) : 'name'
  } catch {
    return 'name'
  }
}

export function saveArtistSort(sort: ArtistSort): void {
  try {
    localStorage.setItem(accountScopedKey(STORAGE_KEY), sort)
  } catch {
    // Applies for this session only; not worth surfacing.
  }
}
