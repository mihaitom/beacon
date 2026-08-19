/** Shared between ArtistDetailView.vue and SimilarArtistsShelf.vue — both
 * render the same set of external artist links (MusicBrainz's own page,
 * connect/core/recommendations.py's get_artist_links()/
 * get_artist_links_by_mbid()), just in different layouts, so the icon/name/
 * ordering/invert metadata lives here once instead of twice. */

import type { ArtistLinkService } from '@/services/connect/recommendations'

export interface ExternalLinkMeta {
  name: string
  icon: string
  // TIDAL and Discogs' own SVGs (public/tidal.svg, public/discogs.svg) are
  // solid near-black glyphs (Discogs on a transparent canvas; TIDAL's had
  // an opaque white background rect too, stripped from the file itself —
  // inverting *that* would've just swapped which color filled the whole
  // square, not made the background transparent). invert(1) turns "black
  // glyph, transparent elsewhere" into "white glyph, transparent
  // elsewhere" — alpha is untouched by the filter, only RGB. The other
  // services' own SVGs already carry real, usable brand colors and don't
  // need this.
  invert?: boolean
}

// 'deezer' isn't part of ArtistLinkService — see that type's own comment,
// it comes from a separate endpoint (getArtistImages()) with its own cache.
export type ExternalLinkKey = ArtistLinkService | 'deezer'

// Order these actually render in — real streaming/marketplace services
// first, MusicBrainz itself last (it's the "raw metadata page" fallback,
// same role it plays as HomeView.vue's own last-resort link used to play
// alone, before this). Typed as ExternalLinkKey[] (not `as const`, unlike
// before this was derived from ArtistLinkService instead of defining its
// own union) so EXTERNAL_LINK_META below is still required to cover every
// member — adding a service to ArtistLinkService without also giving it
// metadata here is a compile error, not a silently-missing icon.
export const EXTERNAL_LINK_ORDER: readonly ExternalLinkKey[] = [
  'spotify',
  'apple_music',
  'tidal',
  'youtube',
  'deezer',
  'discogs',
  'musicbrainz',
]

export const EXTERNAL_LINK_META: Record<ExternalLinkKey, ExternalLinkMeta> = {
  spotify: { name: 'Spotify', icon: '/spotify.svg' },
  apple_music: { name: 'Apple Music', icon: '/apple_music.svg' },
  tidal: { name: 'TIDAL', icon: '/tidal.svg', invert: true },
  youtube: { name: 'YouTube', icon: '/youtube.svg' },
  deezer: { name: 'Deezer', icon: '/deezer.svg' },
  discogs: { name: 'Discogs', icon: '/discogs.svg', invert: true },
  musicbrainz: { name: 'MusicBrainz', icon: '/musicbrainz.svg' },
}

/** Turns a `{key: url}` map (however partial/whichever order) into the
 * ordered, icon-annotated list both components actually render. */
export function toExternalLinkList(
  urls: Partial<Record<ExternalLinkKey, string>>,
): (ExternalLinkMeta & { key: ExternalLinkKey; url: string })[] {
  return EXTERNAL_LINK_ORDER.filter((key) => urls[key]).map((key) => ({
    key,
    url: urls[key]!,
    ...EXTERNAL_LINK_META[key],
  }))
}
