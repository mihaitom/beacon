import { fetchConnect } from './http'
import type { SimilarArtist } from './recommendations'

/** One recording as ListenBrainz knows it. The playlist builder only reads
 * title/artist (see services/library/lastfmMatcher.ts, which is source
 * agnostic); the display fields are what Home's recommendation shelf uses
 * and are empty wherever a query has no way to know them. */
export interface ListenbrainzTrack {
  title: string
  artist: string
  /** MusicBrainz recording id where ListenBrainz has one. Unlike Last.fm's,
   * this is a real MBID, but the matcher still only ever uses it as a
   * confirmation — Beacon's library tracks carry no MBIDs to meet it with. */
  mbid: string
  album: string
  /** A Cover Art Archive URL for the release, or '' when there is none. */
  coverArtUrl: string
  /** Seconds, or 0 where unknown. */
  duration: number
}

export type ListenbrainzOp = 'charts' | 'genre' | 'artist' | 'mytop' | 'recommended'

/** The stats ranges ListenBrainz accepts, validated by the backend too
 * (routes/listenbrainz.py's Period). */
export type ListenbrainzPeriod = 'week' | 'month' | 'quarter' | 'half_yearly' | 'year' | 'all_time'

export interface ListenbrainzQuery {
  op: ListenbrainzOp
  limit: number
  /** genre only — a tag the community uses, e.g. "rock". */
  tag?: string
  /** artist only. */
  artist?: string
  /** mytop and recommended only — a public ListenBrainz name, no login. */
  username?: string
  /** charts and mytop only. */
  period?: ListenbrainzPeriod
}

/** Track lists and personalized recommendations from ListenBrainz, via
 * connect's core/listenbrainz.py. No key and no token: the endpoints are
 * public and a username is passed as a plain parameter. */
export async function getListenbrainzTracks(
  query: ListenbrainzQuery,
): Promise<ListenbrainzTrack[]> {
  const params = new URLSearchParams({ op: query.op, limit: String(query.limit) })
  if (query.tag) params.set('tag', query.tag)
  if (query.artist) params.set('artist', query.artist)
  if (query.username) params.set('username', query.username)
  if (query.period) params.set('period', query.period)
  const data = await fetchConnect<{ tracks: ListenbrainzTrack[] }>(
    `/listenbrainz/tracks?${params.toString()}`,
  )
  return data.tracks
}

/** The artists behind the listener's recommended recordings — Home's
 * personalized shelf. Same `{name, mbid, score}` shape as
 * getSimilarArtists(), so the frontend reuses its enrichment and shelf
 * component unchanged (see core/listenbrainz.py's get_recommended_artists). */
export async function getListenbrainzArtists(
  username: string,
  limit = 30,
): Promise<SimilarArtist[]> {
  const params = new URLSearchParams({ username, limit: String(limit) })
  const data = await fetchConnect<{ artists: SimilarArtist[] }>(
    `/listenbrainz/artists?${params.toString()}`,
  )
  return data.artists
}
