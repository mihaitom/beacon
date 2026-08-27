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
