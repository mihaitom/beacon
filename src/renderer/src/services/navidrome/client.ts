/**
 * The smart playlist editor's calls to Navidrome's own API, through
 * connect's /navidrome route (connect/routes/navidrome.py).
 *
 * That API wants a login with the account's password, which connect turns
 * into a token it keeps for the session. When it has none (a fresh session,
 * or Navidrome stopped accepting the old one), the password Beacon stored at
 * sign-in is sent once without asking. Only when there is none - a login
 * taken over from Remote, say - or Navidrome refuses it does the caller get
 * NavidromeLoginRequired, and the editor asks for the password itself.
 */

import { ConnectApiError, fetchConnect } from '@/services/connect/http'
import { useAuthStore } from '@/stores/auth'

/** The `detail`s connect answers with, as 403s (see its route for why not
 * 401s). */
const LOGIN_REQUIRED = 'navidrome_login_required'
const PASSWORD_REJECTED = 'navidrome_password_rejected'

export class NavidromeLoginRequired extends Error {
  constructor() {
    super('Navidrome needs the password')
    this.name = 'NavidromeLoginRequired'
  }
}

export class NavidromePasswordRejected extends Error {
  constructor() {
    super('Navidrome rejected the password')
    this.name = 'NavidromePasswordRejected'
  }
}

/** A playlist as Navidrome's own API describes it - the parts the editor
 * reads. */
export interface NavidromePlaylist {
  id: string
  name: string
  comment: string
  public: boolean
  /** Navidrome's rules JSON, or null for a playlist that is not smart. */
  rules: unknown
  /** The file it was imported from; empty for one made in a client. A
   * playlist with a path is overwritten from that file at the next library
   * scan once its rules change. */
  path: string
  ownerId: string
}

function detailOf(error: unknown): string | null {
  if (!(error instanceof ConnectApiError)) return null
  const body = error.body
  if (body !== null && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail?: unknown }).detail
    return typeof detail === 'string' ? detail : null
  }
  return null
}

/** Hands connect the password to log into Navidrome with. */
export async function loginToNavidrome(password: string): Promise<void> {
  try {
    await fetchConnect('/navidrome/session', { method: 'POST', body: { password } })
  } catch (error) {
    if (detailOf(error) === PASSWORD_REJECTED) throw new NavidromePasswordRejected()
    throw error
  }
}

/** Logs in with the stored password, if there is one. False when there is
 * none or Navidrome refuses it - a password changed since sign-in. */
async function loginSilently(): Promise<boolean> {
  const password = useAuthStore().password
  if (!password) return false
  try {
    await loginToNavidrome(password)
    return true
  } catch (error) {
    if (error instanceof NavidromePasswordRejected) return false
    throw error
  }
}

async function call<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  try {
    return await fetchConnect<T>(path, options)
  } catch (error) {
    if (detailOf(error) !== LOGIN_REQUIRED) throw error
  }
  if (!(await loginSilently())) throw new NavidromeLoginRequired()
  try {
    return await fetchConnect<T>(path, options)
  } catch (error) {
    // Accepted a moment ago and refused now: no point trying again.
    if (detailOf(error) === LOGIN_REQUIRED) throw new NavidromeLoginRequired()
    throw error
  }
}

export function getNavidromePlaylist(id: string): Promise<NavidromePlaylist> {
  return call<NavidromePlaylist>(`/navidrome/api/playlist/${encodeURIComponent(id)}`)
}

/** Creates a smart playlist and answers its id. */
export async function createSmartPlaylist(playlist: {
  name: string
  rules: Record<string, unknown>
  comment?: string
  public?: boolean
}): Promise<string> {
  const created = await call<{ id: string }>('/navidrome/api/playlist', {
    method: 'POST',
    body: playlist,
  })
  return created.id
}

/** Changes what is given and nothing else - Navidrome's PUT leaves every
 * field the body does not name alone. */
export async function updateSmartPlaylist(
  id: string,
  changes: { name?: string; rules?: Record<string, unknown> },
): Promise<void> {
  await call(`/navidrome/api/playlist/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: changes,
  })
}
