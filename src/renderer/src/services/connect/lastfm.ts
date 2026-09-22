import { fetchConnect } from './http'

/** One track as Last.fm names it — plain text, not yet anything this
 * library owns. Turning these into songs is lastfmMatcher.ts's job. */
export interface LastfmTrack {
  title: string
  artist: string
  /** Last.fm's recording MBID where it has one. Often absent, and not
   * reliable enough to identify a track by on its own - see
   * core/lastfm.py's _to_tracks(). */
  mbid: string
}

export type LastfmOp = 'charts' | 'genre' | 'artist' | 'similar' | 'mytop'

/** The periods user.getTopTracks accepts, validated by the backend too
 * (routes/lastfm.py's Period). */
export type LastfmPeriod = 'overall' | '7day' | '1month' | '3month' | '6month' | '12month'

export interface LastfmQuery {
  op: LastfmOp
  limit: number
  /** charts only - empty means the global chart rather than a country's. */
  country?: string
  /** genre only. */
  tag?: string
  /** artist only. */
  artist?: string
  /** similar only - the seed track's title, together with `artist`. */
  track?: string
  /** mytop only - a public Last.fm username. No login: user.getTopTracks
   * takes the name as a plain parameter. */
  username?: string
  /** mytop only. */
  period?: LastfmPeriod
}

export async function getLastfmTracks(query: LastfmQuery): Promise<LastfmTrack[]> {
  const params = new URLSearchParams({ op: query.op, limit: String(query.limit) })
  if (query.country) params.set('country', query.country)
  if (query.tag) params.set('tag', query.tag)
  if (query.artist) params.set('artist', query.artist)
  if (query.track) params.set('track', query.track)
  if (query.username) params.set('username', query.username)
  if (query.period) params.set('period', query.period)
  const data = await fetchConnect<{ tracks: LastfmTrack[] }>(`/lastfm/songs?${params.toString()}`)
  return data.tracks
}
