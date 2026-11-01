import { fetchConnect } from './http'
import type { ListenbrainzTrack } from './listenbrainz'

/** Same shape as a ListenBrainz track; Deezer has no MBIDs, so that field
 * is always empty. */
export type DeezerTrack = ListenbrainzTrack

export type DeezerOp = 'charts' | 'artist' | 'radio' | 'playlist'

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
  /** artist and radio. */
  artist?: string
  /** playlist only - a Deezer playlist id. The whole playlist comes back,
   * whatever `limit` says. */
  playlist?: number
}

/** A public Deezer playlist, as the builder's picker shows it. */
export interface DeezerPlaylist {
  id: number
  title: string
  owner: string
  trackCount: number
  pictureUrl: string
}

/** Deezer's charts, an artist's top tracks or radio, or a playlist, via
 * connect's core/deezer.py. No key: the endpoints are public. A chart is the one for
 * the country connect's server is in. */
export async function getDeezerTracks(query: DeezerQuery): Promise<DeezerTrack[]> {
  const params = new URLSearchParams({ op: query.op, limit: String(query.limit) })
  if (query.genre !== undefined) params.set('genre', String(query.genre))
  if (query.artist) params.set('artist', query.artist)
  if (query.playlist) params.set('playlist', String(query.playlist))
  const data = await fetchConnect<{ tracks: DeezerTrack[] }>(`/deezer/songs?${params.toString()}`)
  return data.tracks
}

/** The genres Deezer keeps a chart for, named in `language`. */
export async function getDeezerGenres(language: string): Promise<DeezerGenre[]> {
  const params = new URLSearchParams({ lang: language })
  const data = await fetchConnect<{ genres: DeezerGenre[] }>(`/deezer/genres?${params.toString()}`)
  return data.genres
}

/** Public Deezer playlists: the popular ones for an empty query, a search
 * otherwise, or the one playlist behind a pasted Deezer link. */
export async function searchDeezerPlaylists(query: string): Promise<DeezerPlaylist[]> {
  const params = new URLSearchParams({ q: query })
  const data = await fetchConnect<{ playlists: DeezerPlaylist[] }>(
    `/deezer/playlists?${params.toString()}`,
  )
  return data.playlists
}
