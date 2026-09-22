import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubsonicClient } from '../client'

/** The alphabet index bar jumps by the server's sort name, not by the
 * display name — Navidrome files "La Bête Blooms" under B. The list calls
 * have to carry that sort name onto the mapped items for the bar to jump to
 * the right section. */
describe('SubsonicClient sort name mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stub(body: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return {
          ok: true,
          json: async () => ({ 'subsonic-response': { status: 'ok', ...body } }),
        } as Response
      }),
    )
  }

  const client = new SubsonicClient('http://connect:8080', 'u=bob&t=abc&s=xyz', 'connect-token')

  it('keeps an artist sort name', async () => {
    stub({
      artists: {
        index: [
          {
            name: 'B',
            artist: [{ id: '1', name: 'La Bête Blooms', sortName: 'bête blooms', albumCount: 1 }],
          },
        ],
      },
    })

    const artists = await client.getArtists()

    expect(artists.map((a) => [a.name, a.sortName])).toEqual([['La Bête Blooms', 'bête blooms']])
  })

  it('keeps an album sort name', async () => {
    stub({
      albumList2: {
        album: [{ id: '1', name: 'The Wall', sortName: 'wall', songCount: 1, duration: 1 }],
      },
    })

    const albums = await client.getAlbumList2('alphabeticalByName')

    expect(albums.map((a) => [a.name, a.sortName])).toEqual([['The Wall', 'wall']])
  })

  it('reads a missing sort name as null', async () => {
    stub({ albumList2: { album: [{ id: '1', name: 'Wall', songCount: 1, duration: 1 }] } })

    const albums = await client.getAlbumList2('alphabeticalByName')

    expect(albums[0]?.sortName).toBeNull()
  })
})
