import { fetchConnect } from './http'

// How connect sends the older Sonos models (Play:3, first-generation
// Playbar) a song - see connect's core/older_sonos.py. Installation-wide,
// like the log level.

export type OlderSonosMode = 'whole' | 'paced' | 'file'

interface OlderSonosResponse {
  mode: OlderSonosMode
}

export async function getOlderSonosMode(): Promise<OlderSonosResponse> {
  return fetchConnect<OlderSonosResponse>('/older-sonos')
}

export async function setOlderSonosMode(mode: OlderSonosMode): Promise<void> {
  await fetchConnect<OlderSonosResponse>('/older-sonos', { method: 'POST', body: { mode } })
}
