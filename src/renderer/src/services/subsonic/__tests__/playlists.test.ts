import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubsonicClient } from '../client'

/** Reordering has no call of its own in Subsonic: createPlaylist with a
 * playlistId is the update form, and the song list travels as a repeated
 * key. Both are easy to get subtly wrong in a way that silently truncates a
 * playlist to one song (see routes/proxy.py's own comment on the same
 * mistake made server-side once). */
describe('SubsonicClient playlist songs', () => {
  const client = new SubsonicClient('http://connect:8080', 'u=bob&t=abc&s=xyz', 'connect-token')
  let requested: URL

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested = new URL(url)
        return {
          ok: true,
          json: async () => ({ 'subsonic-response': { status: 'ok' } }),
        } as Response
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the whole order as one repeated songId parameter', async () => {
    await client.setPlaylistSongs('pl-1', ['s3', 's1', 's2'])

    expect(requested.pathname).toBe('/rest/createPlaylist.view')
    expect(requested.searchParams.get('playlistId')).toBe('pl-1')
    // getAll, not get: the order is the entire point, and a dict-style
    // collapse would leave the playlist holding only the last song.
    expect(requested.searchParams.getAll('songId')).toEqual(['s3', 's1', 's2'])
  })

  it('sends no name, so renaming is not a side effect of reordering', async () => {
    await client.setPlaylistSongs('pl-1', ['s1'])

    expect(requested.searchParams.get('name')).toBeNull()
  })

  it('can empty a playlist — an order of nothing is still a valid order', async () => {
    await client.setPlaylistSongs('pl-1', [])

    expect(requested.searchParams.getAll('songId')).toEqual([])
    expect(requested.searchParams.get('playlistId')).toBe('pl-1')
  })
})

/** Navidrome reports both through OpenSubsonic fields; a server that does
 * not know them must not end up with every playlist locked. */
describe('SubsonicClient playlist flags', () => {
  const client = new SubsonicClient('http://connect:8080', 'u=bob&t=abc&s=xyz', 'connect-token')

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads readonly, and validUntil as the sign of a smart playlist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          'subsonic-response': {
            status: 'ok',
            playlists: {
              playlist: [
                {
                  id: 'smart',
                  name: 'Unplayed',
                  songCount: 0,
                  duration: 0,
                  readonly: true,
                  validUntil: '2026-10-11T12:00:00Z',
                },
                { id: 'synced', name: 'From m3u', songCount: 0, duration: 0, readonly: true },
                { id: 'plain', name: 'Old server', songCount: 0, duration: 0 },
              ],
            },
          },
        }),
      })),
    )

    const flags = (await client.getPlaylists()).map(({ id, readonly, smart }) => ({
      id,
      readonly,
      smart,
    }))
    expect(flags).toEqual([
      { id: 'smart', readonly: true, smart: true },
      { id: 'synced', readonly: true, smart: false },
      { id: 'plain', readonly: false, smart: false },
    ])
  })

  it('keeps what a bridge says about ownership, and leaves it out where it says nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          'subsonic-response': {
            status: 'ok',
            playlists: {
              playlist: [
                { id: 'mine', name: 'A', songCount: 0, duration: 0, owned: true },
                { id: 'shared', name: 'B', songCount: 0, duration: 0, owned: false },
                { id: 'named', name: 'C', songCount: 0, duration: 0, owner: 'bob' },
              ],
            },
          },
        }),
      })),
    )

    const [mine, shared, named] = await client.getPlaylists()
    expect(mine!.ownedByUser).toBe(true)
    expect(shared!.ownedByUser).toBe(false)
    expect(named).not.toHaveProperty('ownedByUser')
  })
})

/** Whether Settings offers a library rescan at all hangs on this answer,
 * and the three states are genuinely different: an admin, a listener, and
 * a server that never answered the question. */
describe('SubsonicClient.isAdmin', () => {
  function respond(body: unknown, ok = true): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok, json: async () => body }) as Response),
    )
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const client = new SubsonicClient('http://connect:8080', 'u=bob&t=abc&s=xyz', 'connect-token')

  it('reports a real admin', async () => {
    respond({ 'subsonic-response': { status: 'ok', user: { username: 'bob', adminRole: true } } })

    await expect(client.isAdmin('bob')).resolves.toBe(true)
  })

  it('reports an ordinary listener', async () => {
    respond({ 'subsonic-response': { status: 'ok', user: { username: 'bob', adminRole: false } } })

    await expect(client.isAdmin('bob')).resolves.toBe(false)
  })

  it('answers null when the server has no such field', async () => {
    // Not "false": a server that never mentions adminRole has said nothing
    // about this account, and treating silence as a denial would hide a
    // working button.
    respond({ 'subsonic-response': { status: 'ok', user: { username: 'bob' } } })

    await expect(client.isAdmin('bob')).resolves.toBeNull()
  })

  it('answers null rather than throwing when the call fails outright', async () => {
    // getUser.view is standard Subsonic but not universal, and this runs
    // as part of signing in — it must never be able to fail a login.
    respond({ 'subsonic-response': { status: 'failed', error: { code: 0 } } })

    await expect(client.isAdmin('bob')).resolves.toBeNull()
  })
})
