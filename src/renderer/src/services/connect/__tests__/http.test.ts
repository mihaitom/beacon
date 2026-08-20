import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { ConnectApiError, ConnectUnauthorizedError, fetchConnect } from '../http'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('fetchConnect', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiUrl = 'http://connect.local'
    auth.connectToken = 'test-token'
    auth.sessionId = 'test-session'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('attaches the connect token and session headers and returns parsed JSON', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { ok: true }))

    const result = await fetchConnect<{ ok: boolean }>('/devices')

    expect(result).toEqual({ ok: true })
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe('http://connect.local/devices')
    expect((init!.headers as Record<string, string>)['X-Connect-Token']).toBe('test-token')
    expect((init!.headers as Record<string, string>)['X-Connect-Session']).toBe('test-session')
  })

  it('omits the session header when withSession is false', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { ok: true }))

    await fetchConnect('/config', { withSession: false })

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    expect((init!.headers as Record<string, string>)['X-Connect-Session']).toBeUndefined()
  })

  it('wraps a network failure in ConnectApiError instead of letting it propagate raw', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(fetchConnect('/devices')).rejects.toBeInstanceOf(ConnectApiError)
  })

  it('treats an HTTP-200 response shaped like a connect error as a failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { error: 'device_in_use' }))

    await expect(fetchConnect('/play')).rejects.toMatchObject({
      message: 'device_in_use',
    })
  })

  it('surfaces the FastAPI `detail` message for a non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(404, { detail: 'Device not found' }))

    await expect(fetchConnect('/devices/abc')).rejects.toMatchObject({
      message: 'Connect request failed: Device not found',
    })
  })

  it('falls back to status/URL when a non-ok response has no `detail`', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }))

    const error: unknown = await fetchConnect('/devices/abc').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConnectApiError)
    expect((error as ConnectApiError).message).toContain('404')
    expect((error as ConnectApiError).message).toContain('http://connect.local/devices/abc')
  })

  it('on a 401, re-authenticates once and retries the request', async () => {
    const auth = useAuthStore()
    const authenticate = vi.spyOn(auth, '_authenticate').mockImplementation(async () => {
      auth.sessionId = 'fresh-session'
    })
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(401, { detail: 'Session expired' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))

    const result = await fetchConnect<{ ok: boolean }>('/devices')

    expect(result).toEqual({ ok: true })
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    const [, secondInit] = vi.mocked(fetch).mock.calls[1]!
    expect((secondInit!.headers as Record<string, string>)['X-Connect-Session']).toBe(
      'fresh-session',
    )
  })

  it('does not retry a 401 on /config itself, to avoid recursing through _authenticate -> postConfig -> /config', async () => {
    const auth = useAuthStore()
    const authenticate = vi.spyOn(auth, '_authenticate')
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(401, { detail: 'Invalid token' }))

    await expect(fetchConnect('/config')).rejects.toBeInstanceOf(ConnectUnauthorizedError)
    expect(authenticate).not.toHaveBeenCalled()
    expect(auth.authenticated).toBe(false)
  })

  it('throws a real ConnectUnauthorizedError and clears `authenticated` when the retry itself fails', async () => {
    const auth = useAuthStore()
    auth.authenticated = true
    vi.spyOn(auth, '_authenticate').mockRejectedValueOnce(new Error('still unauthenticated'))
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(401, { detail: 'Session expired' }))

    await expect(fetchConnect('/devices')).rejects.toBeInstanceOf(ConnectUnauthorizedError)
    expect(auth.authenticated).toBe(false)
    // Only the original request was attempted — the failed re-auth doesn't
    // get its own retry loop.
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
