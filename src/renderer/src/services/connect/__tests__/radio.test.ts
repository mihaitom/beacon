import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchConnect } from '../http'
import { RADIO_FAVICON_CACHE_VERSION, radioFaviconUrl, resolveRadioStreamUrl } from '../radio'

vi.mock('../http', () => ({ fetchConnect: vi.fn() }))

describe('radioFaviconUrl', () => {
  it('builds the plain homepage-only URL when nothing else is given', () => {
    const url = radioFaviconUrl('https://api.example', 'tok', 'https://station.example')
    expect(url).toBe(
      'https://api.example/radio-favicon?url=https%3A%2F%2Fstation.example&token=tok' +
        `&v=${RADIO_FAVICON_CACHE_VERSION}`,
    )
  })

  it('always carries the cache version, so a bump walks away from stale entries', () => {
    // Not just cosmetic: a poisoned cache entry (see the constant's own
    // comment) is unreachable from the app in every other way, and the
    // only lever left is asking for a URL nothing has stored yet.
    for (const url of [
      radioFaviconUrl('https://api.example', 'tok', 'https://station.example'),
      radioFaviconUrl('https://api.example', '', '', 96, 'https://cdn.example/icon.png'),
    ]) {
      expect(new URL(url).searchParams.get('v')).toBe(RADIO_FAVICON_CACHE_VERSION)
    }
  })

  it('adds min_size only when positive', () => {
    const url = radioFaviconUrl('https://api.example', 'tok', 'https://station.example', 32)
    expect(url).toContain('min_size=32')
  })

  it('adds the Radio Browser favicon hint when given', () => {
    const url = radioFaviconUrl(
      'https://api.example',
      'tok',
      'https://station.example',
      0,
      'https://cdn.example/icon.png',
    )
    expect(url).toContain('hint=https%3A%2F%2Fcdn.example%2Ficon.png')
  })

  it('omits the hint for a station that never had one', () => {
    const url = radioFaviconUrl('https://api.example', 'tok', 'https://station.example')
    expect(url).not.toContain('hint=')
  })

  it('omits the token entirely when there is none', () => {
    const url = radioFaviconUrl('https://api.example', '', 'https://station.example')
    expect(url).not.toContain('token')
  })

  it('omits url entirely and relies on the hint when there is no homepage', () => {
    const url = radioFaviconUrl('https://api.example', 'tok', '', 0, 'https://cdn.example/icon.png')
    expect(url).not.toContain('url=')
    expect(url).toContain('hint=https%3A%2F%2Fcdn.example%2Ficon.png')
  })
})

describe('resolveRadioStreamUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('asks the backend what a .m3u station really points at', async () => {
    const stream = 'http://dispatcher.rndfnk.com/br/br24/live/mp3/mid'
    vi.mocked(fetchConnect).mockResolvedValue({ url: stream })

    const resolved = await resolveRadioStreamUrl('http://streams.br.de/b5aktuell_2.m3u')

    expect(resolved).toBe(stream)
    expect(fetchConnect).toHaveBeenCalledWith(
      '/radio-stream-url?url=http%3A%2F%2Fstreams.br.de%2Fb5aktuell_2.m3u',
    )
  })

  it.each(['.pls', '.asx', '.xspf'])('resolves a %s station too', async (extension) => {
    vi.mocked(fetchConnect).mockResolvedValue({ url: 'http://stream.example/live' })
    await resolveRadioStreamUrl(`http://station.example/x${extension}`)
    expect(fetchConnect).toHaveBeenCalledOnce()
  })

  it.each([
    'http://mp3channels.webradio.rockantenne.de/rockantenne',
    'http://station.example/stream.mp3',
    // HLS is the live format itself, not an indirection to resolve away.
    'http://station.example/live.m3u8',
    // The extension has to be the path's, not the query string's.
    'http://station.example/stream?playlist=foo.m3u',
  ])('never pays a round trip for %s', async (url) => {
    expect(await resolveRadioStreamUrl(url)).toBe(url)
    expect(fetchConnect).not.toHaveBeenCalled()
  })

  it('falls back to the original URL when the backend request fails', async () => {
    vi.mocked(fetchConnect).mockRejectedValue(new Error('unreachable'))
    const url = 'http://streams.br.de/b5aktuell_2.m3u'
    // Playback is better off trying the URL it has than not starting at all.
    expect(await resolveRadioStreamUrl(url)).toBe(url)
  })

  it('falls back to the original URL when the backend answers with an empty one', async () => {
    vi.mocked(fetchConnect).mockResolvedValue({ url: '' })
    const url = 'http://streams.br.de/b5aktuell_2.m3u'
    expect(await resolveRadioStreamUrl(url)).toBe(url)
  })
})
