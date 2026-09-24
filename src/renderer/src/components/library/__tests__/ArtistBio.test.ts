import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import ArtistBio from '../ArtistBio.vue'

// jsdom lays nothing out and resolves no stylesheet, so both the paragraph's
// height and its line-height have to be told to the component: how many lines
// the text would take, at a fixed 20px per line.
function fakeLines(lines: number) {
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(lines * 20)
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    lineHeight: '20px',
  } as unknown as CSSStyleDeclaration)
}

// The clamp is measured on mount, so its answer lands one render later.
async function mountBio(
  props: { text?: string; url?: string | null; lang?: string; maxLines?: number } = {},
) {
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
  it('shows a paragraph of up to five lines in full', async () => {
    fakeLines(5)
    const wrapper = await mountBio()

    expect(toggle(wrapper).exists()).toBe(false)
    expect(wrapper.find('p').classes()).not.toContain('artist-bio__text--collapsed')
  })

  it('collapses a paragraph past five lines', async () => {
    fakeLines(6)
    const wrapper = await mountBio()

    expect(toggle(wrapper).exists()).toBe(true)
    expect(wrapper.find('p').classes()).toContain('artist-bio__text--collapsed')
  })

  it('expands a clamped paragraph and collapses it again', async () => {
    fakeLines(8)
    const wrapper = await mountBio()

    await toggle(wrapper).trigger('click')
    expect(toggle(wrapper).attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('p').classes()).not.toContain('artist-bio__text--collapsed')

    await toggle(wrapper).trigger('click')
    expect(toggle(wrapper).attributes('aria-expanded')).toBe('false')
  })

  it('starts collapsed again for a different text', async () => {
    fakeLines(8)
    const wrapper = await mountBio()
    await toggle(wrapper).trigger('click')

    await wrapper.setProps({ text: 'Another band.' })

    expect(toggle(wrapper).attributes('aria-expanded')).toBe('false')
  })

  it('links the article it came from', async () => {
    fakeLines(3)
    const link = (await mountBio()).find('a')

    expect(link.attributes('href')).toBe('https://en.wikipedia.org/wiki/X')
  })

  it('shows no link without an article URL', async () => {
    fakeLines(3)
    expect((await mountBio({ url: null })).find('a').exists()).toBe(false)
  })

  it('marks the paragraph with the language it is actually in', async () => {
    fakeLines(3)
    expect((await mountBio({ lang: 'de' })).find('p').attributes('lang')).toBe('de')
  })

  it('collapses past a shorter limit where the page asks for one', async () => {
    // The album page's header has room for three lines, not five.
    fakeLines(4)
    const wrapper = await mountBio({ maxLines: 3 })

    expect(toggle(wrapper).exists()).toBe(true)
    expect(wrapper.find('p').classes()).toContain('artist-bio__text--collapsed')
  })
})
