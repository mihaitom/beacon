import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubsonicClient } from '../client'

const client = new SubsonicClient('http://connect:8080', 'u=bob&t=abc&s=xyz', 'tok', 'sess')

function answer(body: Record<string, unknown>) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    json: async () => ({ 'subsonic-response': { status: 'ok', ...body } }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const entries = [
  { id: 'a', title: 'A' },
  { id: 'b', title: 'B' },
  { id: 'a', title: 'A' },
]

describe('SubsonicClient play queue', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** The whole reason for the index form: the plain one names the
   * current song by id, and "a" is in this queue twice. */
  it('reads the current copy of a duplicated song by index', async () => {
    answer({
      playQueueByIndex: {
        entry: entries,
        currentIndex: 2,
        position: 61500,
        changed: '2026-10-19T10:00:00Z',
        changedBy: 'feishin',
      },
    })

    const queue = await client.getPlayQueue(true)

    expect(queue?.currentIndex).toBe(2)
    expect(queue?.position).toBe(61.5)
    expect(queue?.changed).toBe(Date.parse('2026-10-19T10:00:00Z'))
    expect(queue?.changedBy).toBe('feishin')
    expect(queue?.songs.map((song) => song.id)).toEqual(['a', 'b', 'a'])
  })

  it('finds the current song by id on a server without the index form', async () => {
    answer({ playQueue: { entry: entries, current: 'b', changed: '2026-10-19T10:00:00Z' } })

    expect((await client.getPlayQueue(false))?.currentIndex).toBe(1)
  })

  /** What Navidrome sends for an account that never saved one. */
  it('has no queue when the server sends no entries', async () => {
    answer({ playQueue: { username: 'bob', changed: '0001-01-01T00:00:00Z' } })

    expect(await client.getPlayQueue(false)).toBeNull()
  })

  it('posts the queue as a form, with the connect token in the URL', async () => {
    const fetchMock = answer({})

    await client.savePlayQueue(['a', 'b', 'a'], 2, 61.5, {
      byIndex: true,
      formPost: true,
      keepalive: true,
    })

    const [url, init] = fetchMock.mock.calls[0]!
    const requested = new URL(url)
    expect(requested.pathname).toBe('/rest/savePlayQueueByIndex.view')
    expect(requested.searchParams.get('token')).toBe('tok')
    expect(requested.searchParams.get('session')).toBe('sess')
    // No custom header: a keepalive request that needs a preflight is refused.
    expect(init?.headers).toBeUndefined()
    expect(init?.method).toBe('POST')
    expect(init?.keepalive).toBe(true)
    const body = init!.body as URLSearchParams
    expect(body.getAll('id')).toEqual(['a', 'b', 'a'])
    expect(body.get('currentIndex')).toBe('2')
    expect(body.get('position')).toBe('61500')
    expect(body.get('u')).toBe('bob')
  })

  it('names the current song by id in the plain form', async () => {
    const fetchMock = answer({})

    await client.savePlayQueue(['a', 'b'], 1, 0, { byIndex: false, formPost: true })

    const [url, init] = fetchMock.mock.calls[0]!
    const body = init!.body as URLSearchParams
    expect(new URL(url).pathname).toBe('/rest/savePlayQueue.view')
    expect(body.get('current')).toBe('b')
    expect(body.has('currentIndex')).toBe(false)
  })

  /** Without formPost, the Subsonic API's own way: everything in the URL. */
  it('sends the queue in the URL where the server takes no form', async () => {
    const fetchMock = answer({})

    await client.savePlayQueue(['a', 'b'], 1, 0, { byIndex: true, formPost: false })

    const [url, init] = fetchMock.mock.calls[0]!
    const requested = new URL(url)
    expect(init?.method).toBeUndefined()
    expect(requested.searchParams.getAll('id')).toEqual(['a', 'b'])
    expect(requested.searchParams.get('currentIndex')).toBe('1')
    expect(requested.searchParams.get('token')).toBe('tok')
  })

  /** Browsers refuse a keepalive body past 64 KiB outright - without the
   * flag it at least has a chance. */
  it('leaves keepalive off for a queue too long for it', async () => {
    const fetchMock = answer({})
    const ids = Array.from({ length: 3_000 }, (_, i) => `song-id-of-twenty-two-${i}`)

    await client.savePlayQueue(ids, 0, 0, { byIndex: true, formPost: true, keepalive: true })

    expect(fetchMock.mock.calls[0]![1]?.keepalive).toBe(false)
  })

  it('throws instead of guessing the extensions where no answer came', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(client.getOpenSubsonicExtensions()).rejects.toThrow(TypeError)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502 })),
    )
    await expect(client.getOpenSubsonicExtensions()).rejects.toThrow('502')
  })

  it('knows the index form only where the server lists it', async () => {
    answer({ openSubsonicExtensions: [{ name: 'indexBasedQueue', versions: [1] }] })
    expect((await client.getOpenSubsonicExtensions()).has('indexBasedQueue')).toBe(true)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 })),
    )
    expect((await client.getOpenSubsonicExtensions()).size).toBe(0)
  })
})
