import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { fetchConnect } from '../http'
import {
  forgetShownArt,
  getArtistArt,
  nextBackground,
  rememberBackground,
  type ArtistArt,
} from '../fanart'

vi.mock('../http', () => ({ fetchConnect: vi.fn() }))

/** connect's answer: raw Fanart.tv URLs, one of them picked at random. */
function answer(background: string, backgrounds: string[], logo: string | null = null) {
  return { art: { banner: null, background, backgrounds, logo } satisfies ArtistArt }
}

/** The raw Fanart.tv URL a proxied connect URL stands for. */
function raw(url: string | null): string | null {
  return url ? new URL(url, 'http://x').searchParams.get('url') : null
}

beforeEach(() => {
  setActivePinia(createPinia())
  forgetShownArt()
  vi.mocked(fetchConnect).mockReset()
})

describe('getArtistArt', () => {
  it('keeps showing the same background for an artist within a session', async () => {
    // connect picks at random each time; the artist page, the album page
    // and Now Playing must not show three different photos of one artist.
    vi.mocked(fetchConnect)
      .mockResolvedValueOnce(answer('a', ['a', 'b', 'c'], 'logo-1'))
      .mockResolvedValueOnce(answer('c', ['a', 'b', 'c'], 'logo-2'))

    await getArtistArt('Cher')
    const second = await getArtistArt('Cher')

    expect(raw(second!.background)).toBe('a')
    expect(raw(second!.logo)).toBe('logo-1')
  })

  it('takes the new pick once the remembered one is no longer offered', async () => {
    vi.mocked(fetchConnect)
      .mockResolvedValueOnce(answer('a', ['a', 'b']))
      .mockResolvedValueOnce(answer('c', ['b', 'c']))

    await getArtistArt('Cher')
    const second = await getArtistArt('Cher')

    expect(raw(second!.background)).toBe('c')
  })

  it('keeps each artist to its own background', async () => {
    vi.mocked(fetchConnect)
      .mockResolvedValueOnce(answer('a', ['a', 'b']))
      .mockResolvedValueOnce(answer('b', ['a', 'b']))

    await getArtistArt('Cher')
    const other = await getArtistArt('Madonna')

    expect(raw(other!.background)).toBe('b')
  })

  it('follows a background picked with a cycle button', async () => {
    vi.mocked(fetchConnect)
      .mockResolvedValueOnce(answer('a', ['a', 'b', 'c']))
      .mockResolvedValueOnce(answer('a', ['a', 'b', 'c']))

    const first = await getArtistArt('Cher')
    rememberBackground('Cher', first!.backgrounds[2]!)
    const second = await getArtistArt('Cher')

    expect(raw(second!.background)).toBe('c')
  })

  it('is null when connect has nothing for the artist', async () => {
    vi.mocked(fetchConnect).mockResolvedValueOnce({ art: null })

    expect(await getArtistArt('Nobody')).toBeNull()
  })
})

describe('nextBackground', () => {
  it('steps to the following background and wraps round', () => {
    expect(nextBackground(['a', 'b', 'c'], 'a')).toBe('b')
    expect(nextBackground(['a', 'b', 'c'], 'c')).toBe('a')
  })

  it('starts at the first when nothing is shown', () => {
    expect(nextBackground(['a', 'b'], null)).toBe('a')
  })

  it('has nothing to step to with fewer than two', () => {
    expect(nextBackground(['a'], 'a')).toBeNull()
    expect(nextBackground([], null)).toBeNull()
  })
})
