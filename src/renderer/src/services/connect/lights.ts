import { fetchConnect } from './http'

/** One entertainment area as set up in the Hue app. */
export interface LightsArea {
  id: string
  name: string
  lights: number
}

/** connect's Hue setup (connect/routes/lights.py). `areas` and `reachable`
 * are null while there is no pairing; `reachable` false means the bridge
 * did not answer just now. `playing` says whether the lights are following
 * something at this moment, `start_error` why the last start failed. */
export type LightsStyle = 'pulse' | 'calm' | 'party' | 'chase'
export type LightsColourMode = 'theme' | 'palette' | 'rotate' | 'fixed'

/** The picture behind the song the lights followed last: the cover, or the
 * artist picture Now Playing showed instead. `colours` (`#rrggbb`) is empty
 * for one without colour - black and white - where the lights take the
 * theme's colour. */
export interface LightsPicture {
  source: 'cover' | 'artist'
  /** The Fanart.tv image, for an artist picture. */
  url: string | null
  /** The media server's id, for a cover. */
  cover_art_id: string | null
  colours: string[]
  /** The colour the app's accent takes for it on Now Playing, or null
   * where it keeps the theme's - what "theme" lights with. */
  accent: string | null
}

export interface LightsState {
  paired: boolean
  /** Bridges connect sees on the network; empty once one is paired. */
  found: FoundBridge[]
  bridge: { host: string; id: string } | null
  reachable: boolean | null
  areas: LightsArea[] | null
  area_id: string | null
  enabled: boolean
  lead_ms: number
  style: LightsStyle
  colour_mode: LightsColourMode
  /** `#rrggbb`. */
  fixed_colour: string
  /** `#rrggbb`: the theme's accent, as an app last reported it. */
  theme_colour: string
  /** The app's accent follows the picture: "theme" takes its strongest
   * colour. */
  theme_follows_picture: boolean
  /** Percent, 20-100. */
  brightness: number
  /** Null before the lights have followed anything. */
  picture: LightsPicture | null
  playing: boolean
  /** Not `error`: fetchConnect reads any reply with that key as a
   * failure (isConnectError). */
  start_error: string | null
}

export type LightsUpdate = Partial<
  Pick<
    LightsState,
    | 'enabled'
    | 'lead_ms'
    | 'style'
    | 'colour_mode'
    | 'fixed_colour'
    | 'theme_colour'
    | 'theme_follows_picture'
    | 'brightness'
  > & { area_id: string }
>

export interface FoundBridge {
  host: string
  id: string
}

export async function getLights(): Promise<LightsState> {
  return await fetchConnect<LightsState>('/lights')
}

export async function discoverBridges(): Promise<FoundBridge[]> {
  const reply = await fetchConnect<{ bridges: FoundBridge[] }>('/lights/discover', {
    method: 'POST',
  })
  return reply.bridges
}

/** Waits up to half a minute for the bridge's button - press it first. */
export async function pairBridge(host: string): Promise<LightsState> {
  return await fetchConnect<LightsState>('/lights/pair', { method: 'POST', body: { host } })
}

export async function updateLights(update: LightsUpdate): Promise<LightsState> {
  return await fetchConnect<LightsState>('/lights', { method: 'PUT', body: update })
}

export async function forgetBridge(): Promise<void> {
  await fetchConnect('/lights', { method: 'DELETE' })
}

export async function reportLocalPlayback(
  songId: string,
  position: number,
  playing: boolean,
): Promise<void> {
  await fetchConnect('/lights/local', {
    method: 'POST',
    body: { song_id: songId, position, playing },
  })
}

/** Only the picture of `songId` (playing here, the lights on or off), or
 * of the song the lights follow - cheap enough to ask for while the dialog
 * is open, where getLights() asks the bridge too. */
export async function getPicture(songId: string | null = null): Promise<LightsPicture | null> {
  const query = songId ? `?song_id=${encodeURIComponent(songId)}` : ''
  return (await fetchConnect<{ picture: LightsPicture | null }>(`/lights/picture${query}`)).picture
}

/** What Now Playing shows behind `songId`: a Fanart.tv image URL (as
 * Fanart.tv serves it, not routed through connect) or null for the cover. */
export async function reportPicture(songId: string, url: string | null): Promise<void> {
  await fetchConnect('/lights/picture', { method: 'PUT', body: { song_id: songId, url } })
}

export async function stopLocalReport(): Promise<void> {
  await fetchConnect('/lights/local', { method: 'DELETE' })
}

/** connect's analysis of a song (lights/analysis.py's SongLights), for the
 * dialog's preview. */
export interface SongAnalysis {
  /** Values a second of `energy`. */
  energy_rate: number
  /** 0-1 loudness, 1 the song's own loud part. */
  energy: number[]
  /** Null for a song without a beat worth following. */
  beats: { times: number[]; downbeat: number; period: number } | null
  /** 0-1 per beat: how strongly it is heard. Null for every beat a full one. */
  hits: number[] | null
  /** A hit at least this strong counts as a beat heard. */
  heard_from: number
}

/** "pending" while connect is still decoding the song - ask again. */
export type SongAnalysisReply =
  { status: 'pending' | 'failed' } | ({ status: 'ready' } & SongAnalysis)

export async function getSongAnalysis(songId: string): Promise<SongAnalysisReply> {
  const query = new URLSearchParams({ song_id: songId })
  return await fetchConnect<SongAnalysisReply>(`/lights/analysis?${query}`)
}
