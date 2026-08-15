import { fetchConnect } from './http'
import type {
  JellyfinLoginRequest,
  JellyfinLoginResponse,
  JellyfinQuickConnectConnectRequest,
  JellyfinQuickConnectConnectResponse,
  JellyfinQuickConnectInitiateRequest,
  JellyfinQuickConnectInitiateResponse,
} from './types'

/** Exchanges a Jellyfin username/password for an AccessToken + user id (see
 * connect/routes/jellyfin_auth.py) — session-less, like /config's own first
 * call, since there's no session to attach this to yet. */
export async function postJellyfinLogin(
  req: JellyfinLoginRequest,
): Promise<JellyfinLoginResponse> {
  return fetchConnect<JellyfinLoginResponse>('/jellyfin/login', {
    method: 'POST',
    body: req,
    withSession: false,
  })
}

/** Starts a Quick Connect login — returns a short code the user approves
 * on another already-authenticated device (or Jellyfin's own web UI), and
 * a secret to poll with (see postJellyfinQuickConnectStatus()). */
export async function postJellyfinQuickConnectInitiate(
  req: JellyfinQuickConnectInitiateRequest,
): Promise<JellyfinQuickConnectInitiateResponse> {
  return fetchConnect<JellyfinQuickConnectInitiateResponse>('/jellyfin/quickconnect/initiate', {
    method: 'POST',
    body: req,
    withSession: false,
  })
}

/** Polled every couple of seconds while a Quick Connect code is showing —
 * returns {authenticated: false} until the user approves it elsewhere, at
 * which point this same call also completes the secret→token exchange
 * server-side and returns the real credentials in one step. */
export async function postJellyfinQuickConnectStatus(
  req: JellyfinQuickConnectConnectRequest,
): Promise<JellyfinQuickConnectConnectResponse> {
  return fetchConnect<JellyfinQuickConnectConnectResponse>('/jellyfin/quickconnect/connect', {
    method: 'POST',
    body: req,
    withSession: false,
  })
}
