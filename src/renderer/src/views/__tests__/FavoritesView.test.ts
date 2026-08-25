import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import FavoritesView from '../FavoritesView.vue'
import ArtistCard from '@/components/library/ArtistCard.vue'
import CardShelf from '@/components/library/CardShelf.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Album, Artist } from '@/types/library'

const vuetify = createVuetify({ components, directives })

function makeArtist(id: string, name: string): Artist {
  return {
    id,
    name,
    albumCount: 3,
    coverArtId: null,
    imageUrl: null,
    starred: true,
    rating: 0,
    albums: [],
  }
}

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
    starred: true,
    rating: 0,
    songs: [],
  }
}

async function mountFavorites() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/artists/:id', component: { template: '<div />' } },
      { path: '/albums/:id', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()
  const library = useLibraryStore()
  vi.spyOn(library, 'fetchStarred').mockResolvedValue()
  const wrapper = mount(FavoritesView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { SongTable: true, CoverArt: true },
    },
  })
  await wrapper.vm.$nextTick()
  return { wrapper, library }
}

describe('FavoritesView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  // Regression: getStarred2 has always returned artists and the store has
  // always kept them, but this view only ever rendered albums and songs —
  // favouriting an artist looked like it did nothing at all.
  it('lists favourited artists, not just albums and songs', async () => {
    const { wrapper, library } = await mountFavorites()
    library.starred.artists = [makeArtist('ar1', 'The Tide')]
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Artists')
    const cards = wrapper.findAllComponents(ArtistCard)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.props('artist').name).toBe('The Tide')
  })

  describe('shelf/grid toggle', () => {
    /** Both card shelves, in render order: artists, then albums. */
    async function mountWithBoth() {
      const mounted = await mountFavorites()
      mounted.library.starred.artists = [makeArtist('ar1', 'The Tide')]
      mounted.library.starred.albums = [makeAlbum('a1')]
      await mounted.wrapper.vm.$nextTick()
      return mounted
    }

    it('lays the cards out as scrolling shelves by default', async () => {
      const { wrapper } = await mountWithBoth()

      const shelves = wrapper.findAllComponents(CardShelf)
      expect(shelves).toHaveLength(2)
      expect(shelves.every((shelf) => shelf.props('wrap') === false)).toBe(true)
      // Each shelf offers the switch itself, rather than one page-level one.
      expect(shelves.every((shelf) => shelf.props('wrapToggle') === true)).toBe(true)
    })

    it('switches one section without touching the other', async () => {
      const { wrapper } = await mountWithBoth()
      const [artists, albums] = wrapper.findAllComponents(CardShelf)

      await albums!.vm.$emit('update:wrap', true)

      expect(albums!.props('wrap')).toBe(true)
      // Someone with 200 favourite albums and four favourite artists wants
      // exactly this: the albums as a grid, the artists left as a row.
      expect(artists!.props('wrap')).toBe(false)
    })

    it('switches back off again', async () => {
      const { wrapper } = await mountWithBoth()
      const albums = wrapper.findAllComponents(CardShelf)[1]!

      await albums.vm.$emit('update:wrap', true)
      await albums.vm.$emit('update:wrap', false)

      expect(albums.props('wrap')).toBe(false)
    })

    it('remembers each section separately for the next visit', async () => {
      const first = await mountWithBoth()
      await first.wrapper.findAllComponents(CardShelf)[1]!.vm.$emit('update:wrap', true)

      // A fresh mount, as if navigating away and back.
      const second = await mountWithBoth()
      const [artists, albums] = second.wrapper.findAllComponents(CardShelf)

      expect(albums!.props('wrap')).toBe(true)
      expect(artists!.props('wrap')).toBe(false)
    })
  })

  it('leaves the artists section out entirely when none are favourited', async () => {
    const { wrapper, library } = await mountFavorites()
    library.starred.albums = [makeAlbum('a1')]
    await wrapper.vm.$nextTick()

    expect(wrapper.findAllComponents(ArtistCard)).toHaveLength(0)
    expect(wrapper.text()).not.toContain('Artists')
  })

  it('counts artists towards "nothing favourited yet"', async () => {
    // Without this, a library with only favourited artists would show both
    // the artists *and* the "no favorites marked yet" notice.
    const { wrapper, library } = await mountFavorites()
    expect(wrapper.text()).toContain('No favorites marked yet')

    library.starred.artists = [makeArtist('ar1', 'The Tide')]
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('No favorites marked yet')
  })

  it('still lists albums and songs alongside them', async () => {
    const { wrapper, library } = await mountFavorites()
    library.starred.artists = [makeArtist('ar1', 'The Tide')]
    library.starred.albums = [makeAlbum('a1')]
    library.starred.songs = [makeSong('s1')]
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Artists')
    expect(wrapper.text()).toContain('Albums')
    expect(wrapper.text()).toContain('Songs')
  })
})
