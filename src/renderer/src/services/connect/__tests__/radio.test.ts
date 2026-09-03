import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchConnect } from '../http'
import {
  faviconSizeStep,
  radioFaviconKey,
  radioFaviconRequest,
  RADIO_FAVICON_CACHE_VERSION,
  radioFaviconUrl,
  resolveRadioStreamUrl,
} from '../radio'

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

  it('rounds min_size up to one of the shared size steps', () => {
    // Every distinct min_size is another cache key, another backend lookup
    // and another stored copy of one station's logo — the callers' natural
    // 32/48/96/512 is four of those for what is at most two different
    // images. See faviconSizeStep().
    expect(radioFaviconUrl('https://api.example', 'tok', 'https://s.example', 32)).toContain(
      'min_size=64',
    )
    expect(radioFaviconUrl('https://api.example', 'tok', 'https://s.example', 96)).toContain(
      'min_size=512',
    )
  })

  it('asks for the smaller step for a list row and the larger one for artwork', () => {
    expect(faviconSizeStep(32)).toBe(64)
    expect(faviconSizeStep(48)).toBe(64)
    // 96 shares the large step with 512 on purpose: PlayerBar and
    // NowPlayingView show the same station at once, so one shared entry is
    // a request saved rather than a bigger download for nothing.
    expect(faviconSizeStep(96)).toBe(512)
    expect(faviconSizeStep(512)).toBe(512)
  })

  it('leaves a size larger than any step alone', () => {
    expect(faviconSizeStep(1024)).toBe(1024)
  })

  it('leaves "whatever you find" alone rather than rounding it up to a demand', () => {
    expect(faviconSizeStep(0)).toBe(0)
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

describe('radioFaviconRequest / radioFaviconKey', () => {
  it('quantises the requested size, so callers do not have to', () => {
    expect(radioFaviconRequest('https://station.example', 32)).toEqual({
      homePageUrl: 'https://station.example',
      hint: '',
      minSize: 64,
    })
  })

  it('gives two callers asking at different sizes the same key when they share a step', () => {
    // PlayerBar (96) and NowPlayingView (512) showing one station: one
    // lookup between them, not two.
    expect(radioFaviconKey(radioFaviconRequest('https://s.example', 96))).toBe(
      radioFaviconKey(radioFaviconRequest('https://s.example', 512)),
    )
  })

  it('keeps a list row and an artwork slot apart', () => {
    expect(radioFaviconKey(radioFaviconRequest('https://s.example', 32))).not.toBe(
      radioFaviconKey(radioFaviconRequest('https://s.example', 512)),
    )
  })

  it('tells two stations apart by hint alone, for stations with no homepage', () => {
    expect(radioFaviconKey(radioFaviconRequest('', 96, 'https://cdn.example/a.png'))).not.toBe(
      radioFaviconKey(radioFaviconRequest('', 96, 'https://cdn.example/b.png')),
    )
  })

  it('carries the cache version, so a bump invalidates in-memory answers too', () => {
    expect(radioFaviconKey(radioFaviconRequest('https://s.example'))).toContain(
      RADIO_FAVICON_CACHE_VERSION,
    )
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
