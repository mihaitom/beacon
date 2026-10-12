import { fetchConnect } from './http'
import { useAuthStore } from '@/stores/auth'
import type { MixTimelineEntry } from '@/services/playback/mixTimeline'

/** One song as connect's mix takes it - see connect/routes/local_mix.py's
 * MixSong. */
export interface LocalMixSong {
  id: string
  queue_index: number
  gain: number
  duration: number
  album_id: string | null
  disc: number | null
  track: number | null
  bpm: number | null
}

export interface LocalMixState {
  epoch: string
  timeline: MixTimelineEntry[]
  /** Stream seconds at which the mix ends, once that is known. */
  end: number | null
  /** The song after the one being rendered is blending in already - see
   * connect's MixEngine.next_committed. */
  next_committed: boolean
}

type RepeatMode = 'off' | 'all' | 'one'

function path(player: string, rest = ''): string {
  return `/stream/local/mix/${encodeURIComponent(player)}${rest}`
}

export function startLocalMix(
  player: string,
  body: {
    songs: LocalMixSong[]
    position: number
    repeat_mode: RepeatMode
    transitions: { mode: string; crossfade_seconds: number }
  },
): Promise<LocalMixState> {
  return fetchConnect<LocalMixState>(path(player), { method: 'POST', body })
}

export function updateLocalMixQueue(
  player: string,
  songs: LocalMixSong[],
  repeatMode: RepeatMode,
): Promise<unknown> {
  return fetchConnect(path(player, '/queue'), {
    method: 'PUT',
    body: { songs, repeat_mode: repeatMode },
  })
}

export function pauseLocalMix(player: string): Promise<unknown> {
  return fetchConnect(path(player, '/pause'), { method: 'POST' })
}

export function resumeLocalMix(player: string): Promise<unknown> {
  return fetchConnect(path(player, '/resume'), { method: 'POST' })
}

export function stopLocalMix(player: string): Promise<unknown> {
  return fetchConnect(path(player), { method: 'DELETE' })
}

export function fetchLocalMixTimeline(player: string, epoch: string): Promise<LocalMixState> {
  return fetchConnect<LocalMixState>(
    `${path(player, '/timeline')}?epoch=${encodeURIComponent(epoch)}`,
  )
}

/** The audio of `epoch` from stream second `from` on - an `<audio src>`,
 * so token and session travel as query parameters (see streamUrl() in
 * services/subsonic/client.ts). */
export function localMixAudioUrl(
  player: string,
  epoch: string,
  from: number,
  quality: { format: string; bitrate: number },
): string {
  const auth = useAuthStore()
  const params = new URLSearchParams({ epoch, from: from.toFixed(3), fmt: quality.format })
  if (quality.format !== 'flac') params.set('br', String(quality.bitrate))
  if (auth.connectToken) params.set('token', auth.connectToken)
  if (auth.sessionId) params.set('session', auth.sessionId)
  return `${auth.apiUrl}${path(player, '/audio')}?${params.toString()}`
}

/** The same run as a live HLS playlist, for WebKit (connect/core/mix_hls.py):
 * Safari cannot play a stream that declares no length. */
export function localMixHlsUrl(
  player: string,
  epoch: string,
  quality: { format: string; bitrate: number },
): string {
  const auth = useAuthStore()
  const params = new URLSearchParams({ epoch, fmt: quality.format })
  if (quality.format !== 'flac') params.set('br', String(quality.bitrate))
  if (auth.connectToken) params.set('token', auth.connectToken)
  if (auth.sessionId) params.set('session', auth.sessionId)
  return `${auth.apiUrl}${path(player, '/hls/index.m3u8')}?${params.toString()}`
}
