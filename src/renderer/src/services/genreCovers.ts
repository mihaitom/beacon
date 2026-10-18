/** The album covers a genre tile shows (see GenresView.vue). */

import type { Album } from '@/types/library'

/** A stable, well-spread order: the same genre shows the same covers on
 * every visit, and they are not just the first albums of the alphabet,
 * which all start with a digit or an "A". FNV-1a over the album id. */
function scatter(id: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function genresOf(album: Album): string[] {
  if (album.genres?.length) return album.genres
  return album.genre ? [album.genre] : []
}

/** Up to `count` cover art ids per genre, keyed by the genre's name in
 * lower case. One pass over the library for every genre at once - the page
 * shows twenty tiles over a catalogue that can run to tens of thousands of
 * albums. Albums without a cover are left out rather than showing as an
 * empty square, and a cover two albums share (a deluxe edition) counts
 * once. */
export function coversByGenre(albums: Album[], count: number): Map<string, string[]> {
  const candidates = new Map<string, { id: string; rank: number }[]>()
  for (const album of albums) {
    if (!album.coverArtId) continue
    const rank = scatter(album.id)
    for (const genre of genresOf(album)) {
      const key = genre.toLowerCase()
      const list = candidates.get(key) ?? []
      list.push({ id: album.coverArtId, rank })
      candidates.set(key, list)
    }
  }
  const covers = new Map<string, string[]>()
  for (const [genre, list] of candidates) {
    list.sort((a, b) => a.rank - b.rank)
    covers.set(genre, [...new Set(list.map((entry) => entry.id))].slice(0, count))
  }
  return covers
}
