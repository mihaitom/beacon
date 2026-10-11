/**
 * What a text rule's value field suggests: the values the library actually
 * holds for that field, most common first, with how many songs carry each.
 * The field still takes anything typed - Navidrome compares text, and a
 * value missing here may well exist on the server.
 */

import type { Artist, Song } from '@/types/library'

export interface Suggestion {
  value: string
  /** Songs carrying it; null where the count is not known. */
  count: number | null
}

/** Enough to cover a real library's genres and the artists anyone would
 * type, few enough for a menu to stay quick. */
const MAX_SUGGESTIONS = 500

function songValue(song: Song, field: string): string | null {
  switch (field) {
    case 'artist':
      return song.artist
    case 'album':
      return song.album
    case 'genre':
      return song.genre
    case 'filetype':
      return song.format
    default:
      return null
  }
}

// Counting walks the whole catalogue, and every text row asks; the answer
// only changes when the catalogue does.
const cache = new WeakMap<readonly Song[], Map<string, Suggestion[]>>()

function counted(songs: readonly Song[], field: string): Suggestion[] {
  let byField = cache.get(songs)
  if (!byField) {
    byField = new Map()
    cache.set(songs, byField)
  }
  const known = byField.get(field)
  if (known) return known

  const counts = new Map<string, number>()
  for (const song of songs) {
    const value = songValue(song, field)?.trim()
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  const result = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SUGGESTIONS)
    .map(([value, count]) => ({ value, count }))
  byField.set(field, result)
  return result
}

export function suggestionsFor(
  field: string,
  songs: readonly Song[],
  artists: readonly Artist[],
): Suggestion[] {
  // Songs do not carry their album artist (see preview.ts); the artist
  // list is the server's album artists, which is the same set of names.
  if (field === 'albumartist') {
    return artists.slice(0, MAX_SUGGESTIONS).map((artist) => ({ value: artist.name, count: null }))
  }
  if (field === 'title') return []
  return counted(songs, field)
}
