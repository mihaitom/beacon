import { fetchConnect } from './http'
import type { ListenbrainzTrack } from './listenbrainz'

/** Same shape as a ListenBrainz track; Deezer has no MBIDs, so that field
 * is always empty. */
export type DeezerTrack = ListenbrainzTrack

export type DeezerOp = 'charts' | 'artist'

export interface DeezerGenre {
  /** 0 is Deezer's overall chart. */
  id: number
  name: string
}

export interface DeezerQuery {
  op: DeezerOp
  limit: number
  /** charts only. */
  genre?: number
  /** artist only. */
  artist?: string
}

/** Deezer's charts and an artist's top tracks, via connect's
 * core/deezer.py. No key: the endpoints are public. A chart is the one for
 * the country connect's server is in. */
export async function getDeezerTracks(query: DeezerQuery): Promise<DeezerTrack[]> {
  const params = new URLSearchParams({ op: query.op, limit: String(query.limit) })
  if (query.genre !== undefined) params.set('genre', String(query.genre))
  if (query.artist) params.set('artist', query.artist)
  const data = await fetchConnect<{ tracks: DeezerTrack[] }>(`/deezer/songs?${params.toString()}`)
  return data.tracks
}

/** The genres Deezer keeps a chart for, named in `language`. */
export async function getDeezerGenres(language: string): Promise<DeezerGenre[]> {
  const params = new URLSearchParams({ lang: language })
  const data = await fetchConnect<{ genres: DeezerGenre[] }>(`/deezer/genres?${params.toString()}`)
  return data.genres
}
