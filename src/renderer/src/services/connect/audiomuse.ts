import { fetchConnect } from './http'
import { mapArtist, mapSong } from '@/services/subsonic/mappers'
import type { RawArtist, RawSong } from '@/services/subsonic/types'
import type { Artist, Song } from '@/types/library'
import type { ApiKeyStatus } from './apiKeys'

/** AudioMuse-AI through connect (connect/core/audiomuse.py). connect holds
 * the address and token and answers in Subsonic songs, so nothing here
 * knows AudioMuse's own API. */

export type AudioMuseReason =
  'not-configured' | 'unreachable' | 'unauthorized' | 'too-old' | 'no-server' | 'failed'

export interface AudioMuseStatus {
  available: boolean
  reason?: AudioMuseReason
  version?: string
  /** The AudioMuse server holding this session's songs, by its name there. */
  server?: string
}

export interface AudioMuseSettings {
  url: string
  urlFromEnvironment: boolean
  urlFromServer: boolean
  key: ApiKeyStatus
}

/** - similar: neighbours of one song (Song Radio)
 * - discovery: related, but further from the library's mainstream
 * - blend: several songs or artists at once, minus others (Autoplay,
 *   Artist Radio) */
export type SonicMixMethod = 'similar' | 'discovery' | 'blend'

export interface SonicMixItem {
  id: string
  type?: 'song' | 'artist'
}

export interface SonicMixRequest {
  method: SonicMixMethod
  add: SonicMixItem[]
  subtract?: SonicMixItem[]
  n?: number
  /** Ids that must not come back - the queue, usually. */
  exclude?: string[]
}

export function getAudioMuseStatus(): Promise<AudioMuseStatus> {
  return fetchConnect<AudioMuseStatus>('/audiomuse/status')
}

export function getAudioMuseSettings(): Promise<AudioMuseSettings> {
  return fetchConnect<AudioMuseSettings>('/audiomuse/settings')
}

/** `undefined` leaves a value as it is, `''` clears it. */
export function saveAudioMuseSettings(change: {
  url?: string
  key?: string
}): Promise<AudioMuseSettings> {
  return fetchConnect<AudioMuseSettings>('/audiomuse/settings', { method: 'PUT', body: change })
}

/** Throws whenever AudioMuse cannot answer (connect's 503), which every
 * caller treats as "do what you did without it". */
export async function sonicMix(request: SonicMixRequest): Promise<Song[]> {
  const data = await fetchConnect<{ songs: RawSong[] }>('/audiomuse/mix', {
    method: 'POST',
    body: request,
  })
  return data.songs.map(mapSong)
}

/** The songs from `start` (left out) to `end` (last). `length` asks for a
 * path that long, both ends counted - best effort, never padded; without
 * it the path is the song menu's short one. Throws when AudioMuse cannot
 * answer. */
export async function sonicPath(start: string, end: string, length?: number): Promise<Song[]> {
  const data = await fetchConnect<{ songs: RawSong[] }>('/audiomuse/path', {
    method: 'POST',
    body: { start, end, length },
  })
  return data.songs.map(mapSong)
}

/** - sound: by describing how it sounds ("calm piano")
 * - lyrics: by what the lyrics are about ("leaving home") */
export type SonicSearchKind = 'sound' | 'lyrics'

export async function sonicSearch(kind: SonicSearchKind, query: string, n = 20): Promise<Song[]> {
  const data = await fetchConnect<{ songs: RawSong[] }>('/audiomuse/search', {
    method: 'POST',
    body: { kind, query, n },
  })
  return data.songs.map(mapSong)
}

/** The moods AudioMuse sorts songs into ("happy", "relaxed", ...). */
export async function getSonicMoods(): Promise<string[]> {
  const data = await fetchConnect<{ moods: string[] }>('/audiomuse/moods')
  return data.moods
}

/** A mix around one mood; each call starts somewhere else in it. */
export async function sonicMood(mood: string, n = 50, exclude: string[] = []): Promise<Song[]> {
  const data = await fetchConnect<{ songs: RawSong[] }>('/audiomuse/mood', {
    method: 'POST',
    body: { mood, n, exclude },
  })
  return data.songs.map(mapSong)
}

/** The lyric themes this AudioMuse can answer ("onTheRoad", "city", ...). */
export async function getSonicThemes(): Promise<string[]> {
  const data = await fetchConnect<{ themes: string[] }>('/audiomuse/themes')
  return data.themes
}

/** A mix of songs whose lyrics are about one theme; each call draws anew. */
export async function sonicTheme(theme: string, n = 50, exclude: string[] = []): Promise<Song[]> {
  const data = await fetchConnect<{ songs: RawSong[] }>('/audiomuse/theme', {
    method: 'POST',
    body: { theme, n, exclude },
  })
  return data.songs.map(mapSong)
}

/** Library artists that sound like `artistId`, closest first. */
export async function sonicSimilarArtists(artistId: string, n = 12): Promise<Artist[]> {
  const params = new URLSearchParams({ id: artistId, n: String(n) })
  const data = await fetchConnect<{ artists: RawArtist[] }>(`/audiomuse/similar-artists?${params}`)
  return data.artists.map(mapArtist)
}
