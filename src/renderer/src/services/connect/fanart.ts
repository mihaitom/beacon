import { fetchConnect } from './http'
import { useAuthStore } from '@/stores/auth'

/** The artist images Fanart.tv has, already picked down to one of each kind
 * by the backend (connect/core/fanart.py) — see that module for how the
 * most-liked one is chosen and why a lookup failure comes back as null. */
export interface ArtistArt {
  /** A wide banner (roughly 1000×185) for the artist hero. */
  banner: string | null
  /** A full-width background image for the artist page. */
  background: string | null
  /** The artist's logo, transparent where Fanart.tv has one. */
  logo: string | null
}

/** Loads one of Fanart.tv's images through connect, which disk-caches it and
 * serves it with a long Cache-Control — see connect/routes/fanart.py. The
 * token rides in the query because an <img>/background cannot send a header;
 * require_token accepts it there for exactly this. */
export function fanartImageUrl(url: string): string {
  const auth = useAuthStore()
  const params = new URLSearchParams({ url, token: auth.connectToken })
  return `${auth.apiUrl}/fanart/image?${params.toString()}`
}

function proxied(art: ArtistArt): ArtistArt {
  return {
    banner: art.banner ? fanartImageUrl(art.banner) : null,
    background: art.background ? fanartImageUrl(art.background) : null,
    logo: art.logo ? fanartImageUrl(art.logo) : null,
  }
}

/** `null` means there is nothing to show: no Fanart.tv key, an artist
 * MusicBrainz could not resolve, or one Fanart.tv does not have. The URLs
 * come back routed through connect (see fanartImageUrl), so callers use them
 * directly. */
export async function getArtistArt(name: string): Promise<ArtistArt | null> {
  const params = new URLSearchParams({ name })
  const data = await fetchConnect<{ art: ArtistArt | null }>(`/fanart/artist?${params.toString()}`)
  return data.art ? proxied(data.art) : null
}
