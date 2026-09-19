import type { Song } from '@/types/library'

const DAY_MS = 24 * 60 * 60 * 1000

/** How long a song has to have gone unplayed to count as "a while ago". */
export const REDISCOVER_MIN_AGE_DAYS = 90

/** "Played a lot" is relative to the library's own listening: the play
 * count this share of played songs sits at or above. An absolute number
 * would be all of a heavy listener's library and none of a light one's. */
const TOP_SHARE = 0.25

/** A single play is a song someone tried, not one they loved - whatever
 * the quartile says in a library that has hardly been listened to. */
const MIN_PLAY_COUNT = 2

/** Without it, one artist from years ago fills the whole shelf. */
const MAX_PER_ARTIST = 2

export interface RediscoverOptions {
  size: number
  now?: number
  random?: () => number
}

/** Songs played often, but not for at least REDISCOVER_MIN_AGE_DAYS.
 *
 * A weighted draw rather than the top of a sorted list, so the shelf
 * changes between visits and the shuffle button has something to shuffle -
 * weighted by play count, so the songs that were played most still come up
 * most. A song with plays but no last-played date (counts imported from
 * elsewhere) is left out: there is no telling whether it is "a while ago". */
export function pickRediscoverSongs(songs: Song[], options: RediscoverOptions): Song[] {
  const now = options.now ?? Date.now()
  const random = options.random ?? Math.random

  const played = songs.filter((song) => song.playCount > 0)
  if (!played.length) return []
  const minPlays = Math.max(MIN_PLAY_COUNT, topShareThreshold(played))
  const cutoff = now - REDISCOVER_MIN_AGE_DAYS * DAY_MS

  const candidates = played.filter((song) => {
    if (song.playCount < minPlays) return false
    // No date, or one that doesn't parse, is NaN - which is never < cutoff.
    return Date.parse(song.lastPlayed ?? '') < cutoff
  })

  // Efraimidis-Spirakis: one key per song, largest keys win - a weighted
  // draw without replacement in a single sort.
  const drawn = candidates
    .map((song) => ({ song, key: random() ** (1 / song.playCount) }))
    .sort((a, b) => b.key - a.key)

  const perArtist = new Map<string, number>()
  const picked: Song[] = []
  for (const { song } of drawn) {
    if (picked.length >= options.size) break
    const artist = song.artistId || song.artist.toLowerCase()
    const count = perArtist.get(artist) ?? 0
    if (count >= MAX_PER_ARTIST) continue
    perArtist.set(artist, count + 1)
    picked.push(song)
  }
  return picked
}

function topShareThreshold(played: Song[]): number {
  const counts = played.map((song) => song.playCount).sort((a, b) => b - a)
  const index = Math.max(0, Math.ceil(counts.length * TOP_SHARE) - 1)
  return counts[index]!
}
