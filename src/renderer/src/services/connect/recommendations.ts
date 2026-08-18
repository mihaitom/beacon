import { fetchConnect } from './http'

export interface SimilarArtist {
  name: string
  mbid: string
  score: number
}

export interface ArtistImage {
  image: string | null
  link: string | null
}

/** Real "similar artists" for `seeds` (artist names already in the
 * library) via connect's core/recommendations.py (MusicBrainz name->MBID +
 * ListenBrainz Labs similar-artists, both cached server-side) — see
 * HomeView.vue's rerollDiscover(), the only caller. `limit` defaults high
 * (100, the most ListenBrainz Labs' own algorithm can return per seed
 * anyway) — HomeView.vue partitions this into "already owned" vs. "new to
 * explore" *after* the fact, so a small limit here starves the "new"
 * shelf whenever the library already owns most of the top-scoring
 * matches. */
export async function getSimilarArtists(seeds: string[], limit = 100): Promise<SimilarArtist[]> {
  const params = new URLSearchParams()
  for (const seed of seeds) params.append('seed', seed)
  params.set('limit', String(limit))
  const data = await fetchConnect<{ artists: SimilarArtist[] }>(
    `/recommendations/similar-artists?${params.toString()}`,
  )
  return data.artists
}

/** Deezer photo + artist-page link for each of `names` (cached
 * server-side, see core/recommendations.py's get_artist_images()) — used
 * only for artists HomeView.vue has already determined aren't in the
 * library (SimilarArtistsShelf.vue's "New to explore"); an owned artist
 * already has real cover art from the media server itself. `null` for a
 * name Deezer has no match for, same as the map simply omitting a name it
 * couldn't look up would mean — the caller (HomeView.vue) always has a
 * fallback (the MusicBrainz link get_similar_artists() already provided). */
export async function getArtistImages(
  names: string[],
): Promise<Record<string, ArtistImage | null>> {
  if (!names.length) return {}
  const params = new URLSearchParams()
  for (const name of names) params.append('name', name)
  const data = await fetchConnect<{ images: Record<string, ArtistImage | null> }>(
    `/recommendations/artist-images?${params.toString()}`,
  )
  return data.images
}
