import type { Playlist, Song } from '@/types/library'

/** What the playlist overview says about a playlist beyond its name: the
 * covers its artwork cycles through and the artists and genres it is made
 * of. Derived from its songs, which the overview's own list does not carry. */
export interface PlaylistSummary {
  /** Distinct album covers, the albums with the most tracks first. */
  covers: string[]
  /** Distinct artists, the most frequent first. */
  artists: string[]
  /** The most frequent genres. */
  genres: string[]
}

// Enough to keep cycling for a while without the artwork turning into a
// slideshow of every one-off track's album.
export const MAX_COVERS = 12
export const MAX_GENRES = 3
// How many artists a playlist is introduced by before "and N more".
export const LEADING_ARTISTS = 3

/** Most frequent first; ties keep the order they first appeared in, so a
 * playlist where every album has one track cycles in playlist order. */
function rankByCount(values: (string | null | undefined)[]): string[] {
  const counts = new Map<string, number>()
  for (const value of values) {
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value)
}

export function summarizePlaylist(songs: Song[]): PlaylistSummary {
  return {
    covers: rankByCount(songs.map((song) => song.coverArtId)).slice(0, MAX_COVERS),
    artists: rankByCount(songs.map((song) => song.artist)),
    genres: rankByCount(songs.map((song) => song.genre)).slice(0, MAX_GENRES),
  }
}

/** Changes whenever the playlist's content may have: a server that reports
 * `changed` bumps it on every edit, and count and length catch the rest. */
export function summaryKey(playlist: Playlist): string {
  return `${playlist.changed ?? ''}|${playlist.songCount}|${playlist.duration}`
}

export function leadingArtists(artists: string[]): string[] {
  return artists.slice(0, LEADING_ARTISTS)
}
