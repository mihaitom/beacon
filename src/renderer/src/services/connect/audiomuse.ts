import { fetchConnect } from './http'
import { mapSong } from '@/services/subsonic/mappers'
import type { RawSong } from '@/services/subsonic/types'
import type { Song } from '@/types/library'
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
