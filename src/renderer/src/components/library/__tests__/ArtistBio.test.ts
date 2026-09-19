import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import ArtistBio from '../ArtistBio.vue'

// jsdom lays nothing out, so both heights are 0 unless a test says what the
// clamp would have done.
function fakeClamp(scrollHeight: number, clientHeight: number) {
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight)
}

// The clamp is measured on mount, so its answer lands one render later.
async function mountBio(props: { text?: string; url?: string | null; lang?: string } = {}) {
  const wrapper = mount(ArtistBio, {
    props: { text: 'A band.', url: 'https://en.wikipedia.org/wiki/X', lang: 'en', ...props },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return wrapper
}

const toggle = (wrapper: Awaited<ReturnType<typeof mountBio>>) => wrapper.find('button')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ArtistBio', () => {
  it('offers no "show more" when the paragraph fits', async () => {
    fakeClamp(60, 60)

    expect(toggle(await mountBio()).exists()).toBe(false)
  })

  it('expands a clamped paragraph and collapses it again', async () => {
    fakeClamp(120, 60)
    const wrapper = await mountBio()

    await toggle(wrapper).trigger('click')
    expect(toggle(wrapper).attributes('aria-expanded')).toBe('true')

    await toggle(wrapper).trigger('click')
    expect(toggle(wrapper).attributes('aria-expanded')).toBe('false')
  })

  it('starts collapsed again for a different text', async () => {
    fakeClamp(120, 60)
    const wrapper = await mountBio()
    await toggle(wrapper).trigger('click')

    await wrapper.setProps({ text: 'Another band.' })

    expect(toggle(wrapper).attributes('aria-expanded')).toBe('false')
  })

  it('links the article it came from', async () => {
    const link = (await mountBio()).find('a')

    expect(link.attributes('href')).toBe('https://en.wikipedia.org/wiki/X')
  })

  it('shows no link without an article URL', async () => {
    expect((await mountBio({ url: null })).find('a').exists()).toBe(false)
  })

  it('marks the paragraph with the language it is actually in', async () => {
    expect((await mountBio({ lang: 'de' })).find('p').attributes('lang')).toBe('de')
  })
})
