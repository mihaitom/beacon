/** What the artist list knows about an artist beyond what the server sends
 * (name, picture, albums, rating): counted out of the loaded song catalogue,
 * since no server we speak to reports any of it per artist. An artist only
 * heard as a guest on someone else's song counts too - see creditedNames(). */

import { creditedNames } from '@/services/artistCredits'
import type { Song } from '@/types/library'

export interface ArtistStats {
  songCount: number
  /** The genre most of the artist's songs carry. */
  genre: string | null
  firstYear: number | null
  lastYear: number | null
  /** Seconds, every song added up. */
  duration: number
  playCount: number
  /** ISO 8601, the latest of the songs' own. */
  lastPlayed: string | null
  /** ISO 8601, when the latest song by the artist came into the library. */
  added: string | null
}

function later(a: string | null, b: string | null | undefined): string | null {
  if (!b) return a
  if (!a) return b
  return Date.parse(b) > Date.parse(a) ? b : a
}

/** Every credited artist's figures, by artistNameKey(). */
export function artistStatsByName(songs: readonly Song[]): Map<string, ArtistStats> {
  const stats = new Map<string, ArtistStats>()
  const genreCounts = new Map<string, Map<string, number>>()
  for (const song of songs) {
    for (const name of creditedNames(song.artist)) {
      let entry = stats.get(name)
      if (!entry) {
        entry = {
          songCount: 0,
          genre: null,
          firstYear: null,
          lastYear: null,
          duration: 0,
          playCount: 0,
          lastPlayed: null,
          added: null,
        }
        stats.set(name, entry)
      }
      entry.songCount++
      entry.duration += song.duration || 0
      entry.playCount += song.playCount || 0
      if (song.year) {
        entry.firstYear = Math.min(entry.firstYear ?? song.year, song.year)
        entry.lastYear = Math.max(entry.lastYear ?? song.year, song.year)
      }
      entry.lastPlayed = later(entry.lastPlayed, song.lastPlayed)
      entry.added = later(entry.added, song.added)
      if (song.genre) {
        let counts = genreCounts.get(name)
        if (!counts) genreCounts.set(name, (counts = new Map()))
        counts.set(song.genre, (counts.get(song.genre) ?? 0) + 1)
      }
    }
  }
  for (const [name, counts] of genreCounts) {
    let best: [string, number] | null = null
    for (const candidate of counts) if (!best || candidate[1] > best[1]) best = candidate
    stats.get(name)!.genre = best?.[0] ?? null
  }
  return stats
}

/** How a list looks an artist's figures up - null before the catalogue has
 * arrived, and for an artist none of its songs credit. */
export type ArtistStatsOf = (artist: { name: string }) => ArtistStats | null
