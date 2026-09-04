// Written as a safety net before AlbumShelf is moved onto CardShelf.vue's
// shared row — these pin what it does today, not a new contract.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import AlbumShelf from '../AlbumShelf.vue'
import AlbumCard from '../AlbumCard.vue'
import type { Album } from '@/types/library'

const vuetify = createVuetify({ components, directives })

function makeAlbum(id: string): Album {
  return {
    id,
    name: `Album ${id}`,
    artist: 'The Tide',
    artistId: 'ar',
    coverArtId: null,
    year: 2024,
    songCount: 1,
    duration: 200,
    genre: null,
    starred: false,
    rating: 0,
    songs: [],
  }
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/albums/:id', component: { template: '<div />' } },
      { path: '/artists/:id', component: { template: '<div />' } },
    ],
  })
}

async function mountShelf(props: Record<string, unknown> = {}) {
  const router = makeRouter()
  await router.push('/')
  await router.isReady()
  return mount(AlbumShelf, {
    props: { title: 'Recently played', albums: [makeAlbum('a'), makeAlbum('b')], ...props },
    global: { plugins: [vuetify, i18n, router], stubs: { CoverArt: true } },
  })
}

describe('AlbumShelf', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders one card per album under its own heading', async () => {
    const wrapper = await mountShelf()

    expect(wrapper.get('.section-title').text()).toBe('Recently played')
    expect(wrapper.findAllComponents(AlbumCard)).toHaveLength(2)
  })

  it('shows skeletons instead of cards while loading', async () => {
    // Six is the count before anything has been measured — jsdom lays
    // nothing out, so the shelf keeps its default rather than deriving "one
    // card fits" from a width of zero.
    const wrapper = await mountShelf({ loading: true, albums: [] })

    expect(wrapper.findAllComponents(AlbumCard)).toHaveLength(0)
    expect(wrapper.findAll('.album-shelf-skeleton-item')).toHaveLength(6)
  })

  it('draws enough skeletons to fill the row it is actually in', async () => {
    // The reason this is measured at all: a fixed six left a wide window's
    // shelf visibly half empty for as long as it was loading, which on
    // Home's two Discover shelves is long enough to see.
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1420)

    const wrapper = await mountShelf({ loading: true, albums: [] })

    // 1420px holds eight 160px cards with their 20px gaps, plus one more
    // half off the edge so the row reads as continuing.
    expect(wrapper.findAll('.album-shelf-skeleton-item')).toHaveLength(9)
    width.mockRestore()
  })

  it('says so instead of rendering an empty row when there is nothing to show', async () => {
    const wrapper = await mountShelf({ albums: [] })

    expect(wrapper.text()).toContain('Nothing to show')
    expect(wrapper.find('.album-shelf-row').exists()).toBe(false)
  })

  describe('play all', () => {
    it('asks its host to play the shelf rather than playing it itself', async () => {
      const wrapper = await mountShelf()

      await wrapper.get('.mdi-play-circle-outline').element.closest('button')!.click()

      expect(wrapper.emitted('play-all')).toHaveLength(1)
    })

    it('can be turned off for a shelf with no sensible "play everything"', async () => {
      const wrapper = await mountShelf({ showPlayAll: false })

      expect(wrapper.find('.mdi-play-circle-outline').exists()).toBe(false)
    })

    it('is disabled and spinning while the host is still fetching the songs', async () => {
      const wrapper = await mountShelf({ playAllLoading: true })

      const button = wrapper.get('.album-shelf-head button').element as HTMLButtonElement
      expect(button.classList.contains('v-btn--loading')).toBe(true)
      expect(button.disabled).toBe(true)
    })

    it('has nothing to play, and so no button, on an empty shelf', async () => {
      const wrapper = await mountShelf({ albums: [] })

      expect(wrapper.find('.mdi-play-circle-outline').exists()).toBe(false)
    })
  })

  describe('scrolling', () => {
    it('pages the row sideways by a bit less than its own width', async () => {
      const wrapper = await mountShelf()
      const row = wrapper.get('.album-shelf-row').element as HTMLElement
      // jsdom reports 0 for every layout box and has no scrollBy at all.
      Object.defineProperty(row, 'clientWidth', { value: 1000, configurable: true })
      const scrollBy = vi.fn()
      row.scrollBy = scrollBy

      const [left, right] = wrapper.findAll('.album-shelf-nav button')
      await right!.trigger('click')
      expect(scrollBy).toHaveBeenLastCalledWith({ left: 800, behavior: 'smooth' })

      await left!.trigger('click')
      expect(scrollBy).toHaveBeenLastCalledWith({ left: -800, behavior: 'smooth' })
    })

    it('has no chevrons in fit-to-screen mode, which never scrolls', async () => {
      const wrapper = await mountShelf({ fitToScreen: true })

      expect(wrapper.find('.album-shelf-nav').exists()).toBe(false)
      expect(wrapper.get('.album-shelf-row').classes()).toContain('album-shelf-row--fit')
    })
  })

  describe('fit-to-screen', () => {
    it('shows only as many albums as were measured to fit', async () => {
      const albums = Array.from({ length: 10 }, (_, i) => makeAlbum(String(i)))
      const wrapper = await mountShelf({ albums, fitToScreen: true })

      // visibleCount is driven by a ResizeObserver, which jsdom stubs out
      // (see __tests__/setup.ts) — set it directly to check the slicing
      // itself rather than the measuring.
      ;(wrapper.vm as unknown as { visibleCount: number }).visibleCount = 4
      await wrapper.vm.$nextTick()

      expect(wrapper.findAllComponents(AlbumCard)).toHaveLength(4)
    })

    it('shows every album when not fitting to screen, however many there are', async () => {
      const albums = Array.from({ length: 10 }, (_, i) => makeAlbum(String(i)))
      const wrapper = await mountShelf({ albums })

      expect(wrapper.findAllComponents(AlbumCard)).toHaveLength(10)
    })
  })

  it('forwards play-on-click to its cards', async () => {
    const wrapper = await mountShelf({ playOnClick: true })

    expect(wrapper.findAllComponents(AlbumCard).every((c) => c.props('playOnClick'))).toBe(true)
  })

  it('renders an action slot next to the heading', async () => {
    const router = makeRouter()
    await router.push('/')
    await router.isReady()
    const wrapper = mount(AlbumShelf, {
      props: { title: 'Discover', albums: [makeAlbum('a')] },
      slots: { action: '<button class="shelf-action">Reroll</button>' },
      global: { plugins: [vuetify, i18n, router], stubs: { CoverArt: true } },
    })

    expect(wrapper.find('.shelf-action').exists()).toBe(true)
  })
})
