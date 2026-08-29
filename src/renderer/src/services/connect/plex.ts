import { fetchConnect } from './http'
import type {
  PlexPinCheckRequest,
  PlexPinCheckResponse,
  PlexPinInitiateResponse,
  PlexResourcesRequest,
  PlexResourcesResponse,
} from './types'

/** Starts a Plex PIN-linking login (see connect/routes/plex_auth.py) —
 * returns a code plus a ready-built app.plex.tv/auth link to open in the
 * system browser, and the PIN id to poll with
 * (see postPlexPinCheck()). */
export async function postPlexPinInitiate(): Promise<PlexPinInitiateResponse> {
  return fetchConnect<PlexPinInitiateResponse>('/plex/pin/initiate', {
    method: 'POST',
    withSession: false,
  })
}

/** Polled every couple of seconds while waiting for the user to approve
 * the PIN in the browser tab — returns {authenticated: false} until then,
 * at which point it carries the Plex *account* token (not yet a
 * server-scoped one — see postPlexResources()). */
export async function postPlexPinCheck(req: PlexPinCheckRequest): Promise<PlexPinCheckResponse> {
  return fetchConnect<PlexPinCheckResponse>('/plex/pin/check', {
    method: 'POST',
    body: req,
    withSession: false,
  })
}

/** Lists the Plex Media Servers the just-linked account can reach, each
 * with its own server-scoped token — the one actually sent to /config. */
export async function postPlexResources(req: PlexResourcesRequest): Promise<PlexResourcesResponse> {
  return fetchConnect<PlexResourcesResponse>('/plex/resources', {
    method: 'POST',
    body: req,
    withSession: false,
  })
}
