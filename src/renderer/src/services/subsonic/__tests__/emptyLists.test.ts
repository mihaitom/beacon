import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubsonicClient } from '../client'

/** A Subsonic server answers "nothing here" by leaving the list field out
 * altogether, not by sending an empty array — verified against Navidrome,
 * which returns a bare `albumList2: {}` for an offset past the end of the
 * library. Every list call has to read that as an empty result: the album
 * one is asked exactly that question on purpose (fetchAlbumPages() runs
 * several pages at once, so the last wave always overshoots), and a throw
 * there took the whole wave down and froze the catalog at 500 albums.
 */
describe('SubsonicClient list calls on an absent list field', () => {
  let body: Record<string, unknown>

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return {
          ok: true,
          json: async () => ({ 'subsonic-response': { status: 'ok', ...body } }),
        } as Response
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const client = new SubsonicClient('http://connect:8080', 'u=bob&t=abc&s=xyz', 'connect-token')

  it('reads a page past the end of the album list as empty', async () => {
    body = { albumList2: {} }

    await expect(client.getAlbumList2('alphabeticalByName', 500, 100000)).resolves.toEqual([])
  })

  it('reads an empty artist list as empty, index or no index', async () => {
    body = { artists: {} }
    await expect(client.getArtists()).resolves.toEqual([])

    body = { artists: { index: [{ name: 'A' }] } }
    await expect(client.getArtists()).resolves.toEqual([])
  })

  it('reads an account without playlists as empty', async () => {
    body = { playlists: {} }

    await expect(client.getPlaylists()).resolves.toEqual([])
  })

  it('reads a server without radio stations as empty', async () => {
    body = { internetRadioStations: {} }

    await expect(client.getInternetRadioStations()).resolves.toEqual([])
  })
})
