import { fetchConnect } from './http'

export interface SimilarArtist {
  name: string
  mbid: string
  score: number
}

export interface ArtistImage {
  image: string | null
  /** The same photo at Deezer's largest size. Carried separately rather
   * than used everywhere, because the two places it is shown want
   * different things: a 160px card is well served by `image` (250px, sharp
   * even at 2x) and downloading a megapixel for every card in a shelf
   * would be waste, while the artwork viewer fills most of a window and
   * made 250px look exactly like 250px. */
  imageLarge: string | null
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
 * server-side, see core/recommendations.py's get_artist_images()).
 * HomeView.vue uses both fields, only for artists it's already determined
 * aren't in the library (SimilarArtistsShelf.vue's "New to explore") — an
 * owned artist already has real cover art from the media server itself.
 * ArtistDetailView.vue uses just `link`, for an artist that *is* in the
 * library — a name-only lookup either way, so being in the library changes
 * nothing about whether this call works, only whether the image half of
 * the result is worth using. `null` for a name Deezer has no match for,
 * same as the map simply omitting a name it couldn't look up would mean —
 * HomeView.vue has a fallback (the MusicBrainz link get_similar_artists()
 * already provided); ArtistDetailView.vue just shows nothing. */
export async function getArtistImages(
  names: string[],
): Promise<Record<string, ArtistImage | null>> {
  if (!names.length) return {}
  const params = new URLSearchParams()
  for (const name of names) params.append('name', name)
  const data = await fetchConnect<{
    images: Record<
      string,
      { image: string | null; image_large?: string | null; link: string | null } | null
    >
  }>(`/recommendations/artist-images?${params.toString()}`)
  return Object.fromEntries(
    Object.entries(data.images).map(([name, entry]) => [
      name,
      entry && {
        image: entry.image,
        // A backend too old to send it (a browser client against a Beacon
        // that has not been updated) leaves the viewer with the card's own
        // picture, which is what it used to get anyway.
        imageLarge: entry.image_large ?? entry.image,
        link: entry.link,
      },
    ]),
  )
}

// MusicBrainz's own artist page plus whichever of Spotify/Apple Music/
// TIDAL/YouTube/Discogs it has on file — see connect/core/recommendations.py's
// get_artist_links()/get_artist_links_by_mbid(). 'deezer' isn't a member
// here — that one comes from getArtistImages() above instead, a separate
// endpoint with its own separate cache; components/library/
// externalArtistLinks.ts is what merges both into one rendered list.
export type ArtistLinkService =
  'musicbrainz' | 'spotify' | 'apple_music' | 'tidal' | 'youtube' | 'discogs'

export type ArtistLinks = Partial<Record<ArtistLinkService, string>>

/** Per `names`, independent of the Deezer/similar-artists lookups above and
 * of the recommendations Settings toggle those are gated by (see that
 * toggle's own store for why): this is a single, on-demand lookup for one
 * artist page actually open right now, not a background pass over artists
 * nobody asked about. A name missing from the result, or present with an
 * empty object, both mean "nothing to show" — same as get_artist_images(),
 * no need to tell those apart. */
export async function getArtistLinks(names: string[]): Promise<Record<string, ArtistLinks>> {
  if (!names.length) return {}
  const params = new URLSearchParams()
  for (const name of names) params.append('name', name)
  const data = await fetchConnect<{ links: Record<string, ArtistLinks> }>(
    `/recommendations/artist-links?${params.toString()}`,
  )
  return data.links
}

/** Same as getArtistLinks(), keyed by (and starting from) MBIDs already on
 * hand instead of names — HomeView.vue's "New to explore" shelf uses this,
 * since ListenBrainz Labs' own similar-artists response
 * (SimilarArtist.mbid) already gives it a trusted MBID per artist, and a
 * name-based lookup would just make the backend redundantly re-resolve
 * one via a MusicBrainz name search it doesn't need. Gated by the
 * recommendations Settings toggle there (unlike getArtistLinks() above) —
 * this *is* the kind of unasked-for background pass over artists nobody's
 * looking at yet that toggle exists to guard against. */
export async function getArtistLinksByMbid(mbids: string[]): Promise<Record<string, ArtistLinks>> {
  if (!mbids.length) return {}
  const params = new URLSearchParams()
  for (const mbid of mbids) params.append('mbid', mbid)
  const data = await fetchConnect<{ links: Record<string, ArtistLinks> }>(
    `/recommendations/artist-links-by-mbid?${params.toString()}`,
  )
  return data.links
}
