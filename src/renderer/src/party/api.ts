/** The guest API under /party/api/ (connect/routes/party.py). The session
 * is an HttpOnly cookie the browser sends on its own, so nothing here ever
 * holds a secret beyond the moment the invite token is exchanged for it. */

const BASE = '/party/api'

export interface GuestSong {
  id: string
  title: string
  artist: string | null
  album: string | null
  duration: number | null
  cover: string | null
  wished_by?: string | null
}

export interface GuestAlbum {
  id: string
  name: string
  artist: string | null
  year: number | null
  cover: string | null
}

export interface GuestRadio {
  name: string
  /** The station's ICY "now playing" tag, while it sends one. */
  now_playing: string | null
  /** /party/api/radio-logo, changing per station. */
  logo: string | null
}

export interface GuestRequest {
  name: string
  mine: boolean
  /** Only on the guest's own wishes - what withdrawing one takes. */
  id?: string
}

export type UpcomingSong = GuestSong & { request?: GuestRequest }

export interface GuestSnapshot {
  playing: boolean
  position: number
  duration: number
  /** Server time (seconds) `position` was true at. */
  position_at: number
  casting: boolean
  backdrop: boolean
  /** Which of the artist's backgrounds the host shows, and how many. */
  backdrop_index: number
  backdrop_count: number
  lyrics_key: string | null
  current_song: GuestSong | null
  radio: GuestRadio | null
  upcoming: UpcomingSong[]
  me: { name: string }
  limits: { max_pending: number; pending: number }
  skip: { enabled: boolean; votes: number; needed: number; mine: boolean }
}

export interface GuestLyrics {
  song_id: string | null
  synced: boolean
  offset: number
  lines: { time: number; text: string }[]
}

export class PartyApiError extends Error {
  constructor(
    public readonly status: number,
    detail: string,
  ) {
    super(detail || `HTTP ${status}`)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    const init: RequestInit = { method, credentials: 'same-origin' }
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    response = await fetch(`${BASE}${path}`, init)
  } catch {
    throw new PartyApiError(0, 'offline')
  }
  if (!response.ok) {
    let detail = ''
    try {
      detail = ((await response.json()) as { detail?: string }).detail ?? ''
    } catch {
      // A body that isn't JSON says nothing more than the status does.
    }
    throw new PartyApiError(response.status, detail)
  }
  return (await response.json()) as T
}

const q = encodeURIComponent

export const partyApi = {
  join: (token: string, name: string) =>
    request<{ name: string }>('POST', '/join', { token, name }),
  state: () => request<GuestSnapshot>('GET', '/state'),
  lyrics: () => request<GuestLyrics>('GET', '/lyrics'),
  songs: (search: string) =>
    request<{ items: GuestSong[] }>('GET', `/songs?search=${q(search)}&limit=30`),
  albums: (search: string) =>
    request<{ items: GuestAlbum[] }>('GET', `/albums?search=${q(search)}&limit=20`),
  album: (id: string) =>
    request<{ album: GuestAlbum; songs: GuestSong[] }>('GET', `/albums/${q(id)}`),
  wish: (songId: string) => request<{ success: boolean }>('POST', '/wishes', { song_id: songId }),
  withdraw: (requestId: string) =>
    request<{ success: boolean }>('DELETE', `/wishes/${q(requestId)}`),
  skip: () => request<{ success: boolean }>('POST', '/skip'),
  unskip: () => request<{ success: boolean }>('DELETE', '/skip'),
}

export const EVENTS_URL = `${BASE}/events`
export const VISUALIZER_URL = `${BASE}/visualizer`
export const BACKDROP_URL = `${BASE}/backdrop`
