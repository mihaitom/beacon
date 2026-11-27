import { rankByMatch, scoreAllTerms, type MatchField } from '@/services/textSearch'
import type { Album, Artist, Playlist, RadioStation, Song } from '@/types/library'

/** What the phone library's "All" search looks through. */
export interface SearchSources {
  artists: Artist[]
  albums: Album[]
  songs: Song[]
  playlists: Playlist[]
  stations: RadioStation[]
}

interface SectionOf<K extends keyof SearchSources> {
  kind: K
  /** The best matches, cut to the section's limit. */
  items: SearchSources[K]
  /** How many matched in all, for the "show all" link. */
  total: number
}

export type SearchSection = { [K in keyof SearchSources]: SectionOf<K> }[keyof SearchSources]

export type SearchLimits = Record<keyof SearchSources, number>

// Every kind's own name counts double, the same weight the store's search
// gives a song title or an album name. The weights have to agree across
// kinds here, unlike within one list: they are what decides which section
// comes first.
const FIELDS: { [K in keyof SearchSources]: (item: SearchSources[K][number]) => MatchField[] } = {
  artists: (artist) => [{ text: artist.name, weight: 2 }],
  albums: (album) => [{ text: album.name, weight: 2 }, { text: album.artist }],
  songs: (song) => [
    { text: song.title, weight: 2 },
    { text: song.artist },
    { text: song.album, weight: 0.5 },
  ],
  playlists: (playlist) => [{ text: playlist.name, weight: 2 }],
  stations: (station) => [{ text: station.name, weight: 2 }],
}

// On a tie the collection comes before what is in it: "Metallica" matches
// the artist and every one of their songs equally well, and the artist is
// what was looked for.
const KIND_ORDER: (keyof SearchSources)[] = ['artists', 'albums', 'songs', 'playlists', 'stations']

/**
 * One search over every kind at once, as sections of best matches. The
 * sections come in the order of how well their best match answers the
 * query, so a song title lands on the songs and an artist's name on the
 * artist without the reader having to pick which list to search first.
 *
 * Exact spelling, like every other filter field on the phone: switching
 * from here to one of the halves keeps the same term, and that list has to
 * show the same matches.
 */
export function searchEverything(
  query: string,
  sources: SearchSources,
  limits: SearchLimits,
): SearchSection[] {
  if (!query.trim()) return []
  const ranked = KIND_ORDER.map((kind, order) => {
    const fields = FIELDS[kind] as (item: unknown) => MatchField[]
    const matches = rankByMatch(sources[kind] as unknown[], query, fields, { exact: true })
    const best = matches.length ? scoreAllTerms(query, fields(matches[0]), { exact: true }) : 0
    const section = {
      kind,
      items: matches.slice(0, limits[kind]),
      total: matches.length,
    } as SearchSection
    return { section, best, order }
  })
  return ranked
    .filter((entry) => entry.section.total > 0)
    .sort((a, b) => b.best - a.best || a.order - b.order)
    .map((entry) => entry.section)
}
