/**
 * Deterministic session id derived from the media-server login, so the same
 * login always lands on the same Connect session (and reconnects reuse
 * device claims/status instead of spawning a fresh session every login).
 * FNV-1a, matching the old React client's connect-session-id.ts.
 */

/** The address reduced to the server it actually identifies, so two ways of
 * writing the same login don't become two different people.
 *
 * The scheme goes first and deliberately: a media server behind a reverse
 * proxy commonly answers http:// with a 301 to https://, and every HTTP
 * client in connect follows redirects (see media/http_client.py), so a login
 * typed without the "s" verifies, browses and streams perfectly - while
 * hashing to a *different* session. Observed live 2026-08-23: the desktop
 * had cast to a speaker under `https://host`, the phone logged in to
 * `http://host` with the same account, and the phone saw no playback at all,
 * could not control the cast, and was free to take the speaker away from it.
 * Trailing slashes, capitalised hostnames and explicitly-written default
 * ports do the same thing, and no redirect fixes those.
 *
 * Path is kept: a server reachable under a sub-path really is a different
 * server from one at the root of the same host.
 */
export function normalizeServerUrl(url: string): string {
  let rest = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  rest = rest.replace(/\/+$/, '')
  const slash = rest.indexOf('/')
  const authority = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase()
  const path = slash === -1 ? '' : rest.slice(slash)
  return `${authority.replace(/:(80|443)$/, '')}${path}`
}

export function computeConnectSessionId(params: {
  url: string
  serverType: string
  userId: string
  username: string
}): string {
  const identity = params.userId || params.username
  const input = `${normalizeServerUrl(params.url)}::${params.serverType}::${identity}`

  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}
