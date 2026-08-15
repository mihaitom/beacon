import { useAuthStore } from '@/stores/auth'
import { isConnectError } from './types'

export class ConnectApiError extends Error {
  constructor(
    message: string,
    public readonly body: unknown,
  ) {
    super(message)
    this.name = 'ConnectApiError'
  }
}

export class ConnectUnauthorizedError extends ConnectApiError {}

/** FastAPI's HTTPException(detail=...) responses are `{"detail": "..."}` —
 * pulls that out so error messages surfaced to the user (e.g. the login
 * screen's error banner) show the actual backend reason ("Media server
 * rejected the supplied credential") instead of a generic fallback that's
 * the same for every possible cause. Returns null for a non-JSON or
 * differently-shaped body, so callers can fall back to their own default. */
function extractDetail(text: string): string | null {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed?.detail === 'string' ? parsed.detail : null
  } catch {
    return null
  }
}

interface FetchConnectOptions {
  method?: string
  body?: unknown
  /** Skip attaching X-Connect-Session (only /config's first call needs this). */
  withSession?: boolean
}

export async function fetchConnect<T>(
  path: string,
  options: FetchConnectOptions = {},
  isRetry = false,
): Promise<T> {
  const auth = useAuthStore()
  const { method = 'GET', body, withSession = true } = options

  const headers: Record<string, string> = {
    'X-Connect-Token': auth.connectToken,
  }
  if (withSession && auth.sessionId) {
    headers['X-Connect-Session'] = auth.sessionId
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  let response: Response
  try {
    response = await fetch(`${auth.apiUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (cause) {
    throw new ConnectApiError(`Connect backend unreachable at ${auth.apiUrl}`, cause)
  }

  if (response.status === 401) {
    // The connect session got reaped (30 min idle) but our credentials are
    // still valid — silently re-POST /config once and retry, instead of
    // bouncing the user to /login for something that isn't actually an auth
    // failure. Only bail to a real 401 if the retry itself also fails.
    //
    // Excludes /config itself: _authenticate() calls postConfig(), which
    // calls fetchConnect('/config', ...) — if the token is simply invalid
    // (not just an idle-reaped session), /config 401s too, and without this
    // guard that inner call would start its own retry (another
    // _authenticate() → postConfig() → /config → 401 → ...), recursing
    // forever instead of failing cleanly.
    if (!isRetry && path !== '/config') {
      try {
        await auth._authenticate()
        return await fetchConnect<T>(path, options, true)
      } catch {
        // fall through to the real 401 below
      }
    }
    auth.authenticated = false
    const text = await response.text()
    throw new ConnectUnauthorizedError(
      extractDetail(text) ?? 'Connect session not authenticated',
      text,
    )
  }
  if (!response.ok) {
    const text = await response.text()
    const detail = extractDetail(text)
    throw new ConnectApiError(
      detail ? `Connect request failed: ${detail}` : `Connect request failed: ${response.status} ${text}`,
      text,
    )
  }

  const data = (await response.json()) as T
  // A "device_in_use"/generic error can arrive with HTTP 200 — see
  // connect/routes/playback.py, which returns the error dict directly
  // instead of raising an HTTPException.
  if (isConnectError(data)) {
    throw new ConnectApiError((data as { error: string }).error, data)
  }
  return data
}
