import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { hostNowPlayingSource, type HostNowPlayingApi } from '../hostSource'

/** Just the slice of the view a test reaches for; the source reads the
 * rest lazily, so it is never touched. */
function fakeApi(overrides: Partial<HostNowPlayingApi> = {}): HostNowPlayingApi {
  return reactive({
    autoplayAvailable: true,
    setLyricsOffset: vi.fn(),
    ...overrides,
  }) as unknown as HostNowPlayingApi
}

describe('host Now Playing source', () => {
  it('resets the lyrics offset to none, not to its opposite', () => {
    const api = fakeApi()
    const source = hostNowPlayingSource(api)

    source.resetLyricsOffset()

    expect(api.setLyricsOffset).toHaveBeenCalledWith(0)
  })

  it('offers autoplay only where the server can do song radio', () => {
    const api = fakeApi({ autoplayAvailable: false })
    const source = hostNowPlayingSource(api)
    expect(source.capabilities.autoplay).toBe(false)

    api.autoplayAvailable = true

    expect(source.capabilities.autoplay).toBe(true)
  })
})
