import { fetchConnect } from './http'
import { useAuthStore } from '@/stores/auth'

/** The artist images Fanart.tv has, already picked down to one of each kind
 * by the backend (connect/core/fanart.py) — see that module for how the
 * candidates are chosen and why a lookup failure comes back as null. */
export interface ArtistArt {
  /** A wide banner (roughly 1000×185) for the artist hero. */
  banner: string | null
  /** A full-width background image for the artist page. */
  background: string | null
  /** Every background candidate, best first, the shown `background` among
   * them — so a caller can offer another one without a second lookup. */
  backgrounds: string[]
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
    backgrounds: (art.backgrounds ?? []).map((url) => fanartImageUrl(url)),
    logo: art.logo ? fanartImageUrl(art.logo) : null,
  }
}

// The background and logo each artist was shown with this session, by name.
// connect picks at random on every lookup, which on its own would give the
// artist page, the album page and Now Playing three different photos of the
// same artist; this keeps one until the next launch, or until someone steps
// to another (rememberBackground).
const shown = new Map<string, { background: string | null; logo: string | null }>()

/** `null` means there is nothing to show: no Fanart.tv key, an artist
 * MusicBrainz could not resolve, or one Fanart.tv does not have. The URLs
 * come back routed through connect (see fanartImageUrl), so callers use them
 * directly. */
export async function getArtistArt(name: string): Promise<ArtistArt | null> {
  const params = new URLSearchParams({ name })
  const data = await fetchConnect<{ art: ArtistArt | null }>(`/fanart/artist?${params.toString()}`)
  if (!data.art) return null
  const art = proxied(data.art)
  const previous = shown.get(name)
  if (previous?.background && art.backgrounds.includes(previous.background)) {
    art.background = previous.background
  }
  if (previous?.logo && art.logo) art.logo = previous.logo
  shown.set(name, { background: art.background, logo: art.logo })
  return art
}

/** Records that `name` is now shown with `background` - the cycle buttons'
 * pick, so the next page for the same artist keeps it. */
export function rememberBackground(name: string, background: string): void {
  const previous = shown.get(name)
  shown.set(name, { background, logo: previous?.logo ?? null })
}

/** The background after `current` in `backgrounds`, wrapping round - what
 * a cycle button steps to. Null when there is nothing else to show. */
export function nextBackground(backgrounds: string[], current: string | null): string | null {
  if (backgrounds.length < 2) return null
  const index = current ? backgrounds.indexOf(current) : -1
  return backgrounds[(index + 1) % backgrounds.length] ?? null
}

/** Forgets every artist's shown images - for tests, which share this
 * module across cases. */
export function forgetShownArt(): void {
  shown.clear()
}
