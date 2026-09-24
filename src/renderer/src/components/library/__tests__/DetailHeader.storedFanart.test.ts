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
import { getStoredBackgrounds } from '@/services/connect/fanart'
import { useFanartStore } from '@/stores/fanart'
import DetailHeader from '../DetailHeader.vue'

vi.mock('@/services/connect/fanart', () => ({ getStoredBackgrounds: vi.fn() }))
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
        photo: layer.classes().includes('detail-header__backdrop--photo'),
      }
    : null
}

function reducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce') }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(getStoredBackgrounds).mockReset().mockResolvedValue(['a.jpg', 'b.jpg', 'c.jpg'])
  reducedMotion(false)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('DetailHeader stored Fanart.tv backgrounds', () => {
  it("shows one of every artist's stored backgrounds, sharp", async () => {
    const wrapper = await mountHeader({ storedFanart: true })

    expect(getStoredBackgrounds).toHaveBeenCalledWith(undefined)
    expect(shown(wrapper)).toEqual({ image: expect.stringMatching(/^[abc]\.jpg$/), photo: true })
  })

  it("asks for a genre's artists only", async () => {
    await mountHeader({ storedFanart: ['Artist A', 'Artist B'] })

    expect(getStoredBackgrounds).toHaveBeenCalledWith(['Artist A', 'Artist B'])
  })

  it('moves on to the next background after a while', async () => {
    const wrapper = await mountHeader({ storedFanart: true })
    const first = shown(wrapper)!.image

    await vi.advanceTimersByTimeAsync(12_000)

    expect(shown(wrapper)!.image).not.toBe(first)
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

    expect(getStoredBackgrounds).not.toHaveBeenCalled()
    expect(shown(wrapper)?.image ?? null).toBeNull()
  })

  it("keeps a header's own artwork rather than cycling over it", async () => {
    await mountHeader({ storedFanart: true, imageUrl: 'https://art/one.jpg' })

    expect(getStoredBackgrounds).not.toHaveBeenCalled()
  })

  it('does not start over when a genre re-renders with the same artists', async () => {
    const wrapper = await mountHeader({ storedFanart: ['Artist A'] })
    await wrapper.setProps({ storedFanart: ['Artist A'] })
    await flushPromises()

    expect(getStoredBackgrounds).toHaveBeenCalledTimes(1)
  })

  it('stops cycling once it is gone', async () => {
    const wrapper = await mountHeader({ storedFanart: true })
    wrapper.unmount()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves the amber tint off a photo', async () => {
    const wrapper = await mountHeader({ storedFanart: true })
    expect(wrapper.find('.detail-header__scrim').classes()).toContain('detail-header__scrim--photo')

    const cover = await mountHeader({ imageUrl: 'https://art/one.jpg' })
    expect(cover.find('.detail-header__scrim').classes()).not.toContain(
      'detail-header__scrim--photo',
    )
  })
})
