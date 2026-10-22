import { fetchConnect } from './http'

// Whether connect sends the older Sonos models (Play:3, first-generation
// Playbar) their stream at playback speed - see connect's
// core/sonos_pacing.py. Installation-wide, like the log level.

interface SonosPacing {
  paced: boolean
}

export async function getSonosPacing(): Promise<SonosPacing> {
  return fetchConnect<SonosPacing>('/sonos-pacing')
}

export async function setSonosPacing(paced: boolean): Promise<void> {
  await fetchConnect<SonosPacing>('/sonos-pacing', { method: 'POST', body: { paced } })
}
