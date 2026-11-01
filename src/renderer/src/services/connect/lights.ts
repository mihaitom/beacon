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
export type LightsStyle = 'pulse' | 'calm' | 'party' | 'wave'
export type LightsColourMode = 'cover' | 'palette' | 'fixed'

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
  /** Percent, 20-100. */
  brightness: number
  /** The colours of the song the lights followed last, as `#rrggbb`: its
   * artist picture's where Now Playing showed one, else its cover's; null
   * before they have followed anything. */
  picture_colours: string[] | null
  playing: boolean
  /** Not `error`: fetchConnect reads any reply with that key as a
   * failure (isConnectError). */
  start_error: string | null
}

export type LightsUpdate = Partial<
  Pick<
    LightsState,
    'enabled' | 'lead_ms' | 'style' | 'colour_mode' | 'fixed_colour' | 'brightness'
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

/** What Now Playing shows behind `songId`: a Fanart.tv image URL (as
 * Fanart.tv serves it, not routed through connect) or null for the cover. */
export async function reportPicture(songId: string, url: string | null): Promise<void> {
  await fetchConnect('/lights/picture', { method: 'PUT', body: { song_id: songId, url } })
}

export async function stopLocalReport(): Promise<void> {
  await fetchConnect('/lights/local', { method: 'DELETE' })
}
