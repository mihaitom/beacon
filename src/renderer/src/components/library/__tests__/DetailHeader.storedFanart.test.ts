// DetailHeader's stored Fanart.tv backgrounds - the list pages' headers
// (Artists, Albums, Songs, a genre) cycling through what connect has
// already downloaded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { getStoredImages } from '@/services/connect/fanart'
import { useFanartStore } from '@/stores/fanart'
import DetailHeader from '../DetailHeader.vue'

vi.mock('@/services/connect/fanart', () => ({ getStoredImages: vi.fn() }))
// jsdom never fires an image's load event.
vi.mock('@/services/preloadImage', () => ({ preloadImage: vi.fn().mockResolvedValue(undefined) }))

const vuetify = createVuetify({ components, directives })

async function mountHeader(props: Record<string, unknown> = {}) {
  const wrapper = mount(DetailHeader, {
    props: { title: 'Artists', ...props },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
  })
  await flushPromises()
  return wrapper
}

function shown(wrapper: Awaited<ReturnType<typeof mountHeader>>) {
  const layer = wrapper.find('.detail-header__backdrop--active')
  return layer.exists()
    ? {
        image: /url\("?([^")]+)"?\)/.exec(layer.attributes('style') ?? '')?.[1] ?? null,
        kind: layer.classes().includes('detail-header__backdrop--banner')
          ? 'banner'
          : layer.classes().includes('detail-header__backdrop--photo')
            ? 'photo'
            : 'cover',
      }
    : null
}

function reducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce') }))
}

/** What connect has on disk, per kind; anything not named has nothing. */
function storedImages(byKind: Partial<Record<'banner' | 'background', string[]>>) {
  vi.mocked(getStoredImages)
    .mockReset()
    .mockImplementation(async (kind) => byKind[kind] ?? [])
}

beforeEach(() => {
  setActivePinia(createPinia())
  storedImages({ banner: ['a.jpg', 'b.jpg', 'c.jpg'] })
  reducedMotion(false)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('DetailHeader stored Fanart.tv backgrounds', () => {
  it("shows one of every artist's stored banners, sharp", async () => {
    const wrapper = await mountHeader({ storedFanart: true })

    expect(getStoredImages).toHaveBeenCalledWith('banner', undefined)
    expect(shown(wrapper)).toEqual({ image: expect.stringMatching(/^[abc]\.jpg$/), kind: 'banner' })
  })

  it('falls back to background photos until any banners are stored', async () => {
    storedImages({ background: ['photo.jpg'] })
    const wrapper = await mountHeader({ storedFanart: true })

    expect(shown(wrapper)).toEqual({ image: 'photo.jpg', kind: 'photo' })
  })

  it('never mixes the two kinds while there are banners', async () => {
    storedImages({ banner: ['banner.jpg'], background: ['photo.jpg'] })
    const wrapper = await mountHeader({ storedFanart: true })

    expect(getStoredImages).not.toHaveBeenCalledWith('background', undefined)
    expect(shown(wrapper)).toEqual({ image: 'banner.jpg', kind: 'banner' })
  })

  it("asks for a genre's artists only", async () => {
    await mountHeader({ storedFanart: ['Artist A', 'Artist B'] })

    expect(getStoredImages).toHaveBeenCalledWith('banner', ['Artist A', 'Artist B'])
  })

  it('moves on to the next background after a while', async () => {
    const wrapper = await mountHeader({ storedFanart: true })
    const first = shown(wrapper)!.image

    await vi.advanceTimersByTimeAsync(12_000)

    expect(shown(wrapper)!.image).not.toBe(first)
  })

  it("shows connect's order as dealt, first to last", async () => {
    const wrapper = await mountHeader({ storedFanart: true })
    const seen = [shown(wrapper)!.image]

    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(12_000)
      seen.push(shown(wrapper)!.image)
    }

    // connect already shuffles, one artist at a time; starting anywhere but
    // the top would put its last and first back to back.
    expect(seen).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
  })

  it('asks connect for a fresh order once a round is through', async () => {
    const wrapper = await mountHeader({ storedFanart: true })
    storedImages({ banner: ['x.jpg', 'y.jpg'] })

    // a, b, c - then the fourth tick starts the next round.
    await vi.advanceTimersByTimeAsync(3 * 12_000)

    expect(getStoredImages).toHaveBeenCalledTimes(1)
    expect(shown(wrapper)!.image).toBe('x.jpg')
  })

  it('switches to banners once some have arrived', async () => {
    storedImages({ background: ['p1.jpg', 'p2.jpg'] })
    const wrapper = await mountHeader({ storedFanart: true })
    storedImages({ banner: ['banner.jpg'] })

    await vi.advanceTimersByTimeAsync(2 * 12_000)

    expect(shown(wrapper)).toEqual({ image: 'banner.jpg', kind: 'banner' })
  })

  it('stays put while the tab is hidden', async () => {
    const wrapper = await mountHeader({ storedFanart: true })
    const first = shown(wrapper)!.image
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)

    // Two intervals: with three backgrounds, a third would come back round.
    await vi.advanceTimersByTimeAsync(24_000)

    expect(shown(wrapper)!.image).toBe(first)
  })

  it('shows one background and never cycles for reduced motion', async () => {
    reducedMotion(true)
    const wrapper = await mountHeader({ storedFanart: true })
    const first = shown(wrapper)!.image

    // Two intervals: with three backgrounds, a third would come back round.
    await vi.advanceTimersByTimeAsync(24_000)

    expect(shown(wrapper)!.image).toBe(first)
  })

  it('asks for nothing when Fanart.tv is switched off', async () => {
    useFanartStore().enabled = false
    const wrapper = await mountHeader({ storedFanart: true })

    expect(getStoredImages).not.toHaveBeenCalled()
    expect(shown(wrapper)?.image ?? null).toBeNull()
  })

  it("keeps a header's own artwork rather than cycling over it", async () => {
    await mountHeader({ storedFanart: true, imageUrl: 'https://art/one.jpg' })

    expect(getStoredImages).not.toHaveBeenCalled()
  })

  it('does not start over when a genre re-renders with the same artists', async () => {
    const wrapper = await mountHeader({ storedFanart: ['Artist A'] })
    await wrapper.setProps({ storedFanart: ['Artist A'] })
    await flushPromises()

    expect(getStoredImages).toHaveBeenCalledTimes(1)
  })

  it('stops cycling once it is gone', async () => {
    const wrapper = await mountHeader({ storedFanart: true })
    wrapper.unmount()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves the amber tint off Fanart.tv art', async () => {
    const wrapper = await mountHeader({ storedFanart: true })
    expect(wrapper.find('.detail-header__scrim').classes()).toContain('detail-header__scrim--photo')

    const cover = await mountHeader({ imageUrl: 'https://art/one.jpg' })
    expect(cover.find('.detail-header__scrim').classes()).not.toContain(
      'detail-header__scrim--photo',
    )
  })
})
