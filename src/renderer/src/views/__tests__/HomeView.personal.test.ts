// Home's two Discover shelves switch to the listener's own ListenBrainz
// recommendations whenever a name is set (see HomeView.vue's
// loadPersonalShelves()): a recommended artist the library owns contributes
// one of its albums to "Discover in your library", the rest fill "New
// artists to explore". Without a name the community similar-artist lookup
// stays in charge — and since the personal recommendations are fixed per
// listener, the Reroll buttons are hidden while they are.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useLibraryStore } from '@/stores/library'
import { useListenbrainzStore } from '@/stores/listenbrainz'
import HomeView from '../HomeView.vue'
import SimilarArtistsShelf from '@/components/library/SimilarArtistsShelf.vue'
import { getListenbrainzArtists } from '@/services/connect/listenbrainz'
import { getSimilarArtists } from '@/services/connect/recommendations'
import type { Album, Artist } from '@/types/library'

vi.mock('@/services/connect/listenbrainz', () => ({
  getListenbrainzArtists: vi.fn(async () => []),
}))

vi.mock('@/services/connect/recommendations', () => ({
  getSimilarArtists: vi.fn(async () => []),
  getArtistImages: vi.fn(async () => ({})),
  getArtistLinksByMbid: vi.fn(async () => ({})),
}))

// The username store pushes a best-effort sync on set; keep it off the wire.
vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

const vuetify = createVuetify({ components, directives })

function stubLibrary() {
  const library = useLibraryStore()
  vi.spyOn(library, 'fetchFrequentAlbums').mockResolvedValue([])
  vi.spyOn(library, 'fetchRecentlyPlayedAlbums').mockResolvedValue([])
  vi.spyOn(library, 'fetchRandomAlbums').mockResolvedValue([])
  vi.spyOn(library, 'fetchTopSongs').mockResolvedValue([])
  vi.spyOn(library, 'fetchArtists').mockResolvedValue()
  vi.spyOn(library, 'client').mockReturnValue({
    getAlbumList2: vi.fn().mockResolvedValue([]),
    coverArtUrl: () => null,
  } as unknown as ReturnType<typeof library.client>)
}

async function mountHome(prepare?: (library: ReturnType<typeof useLibraryStore>) => void) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  stubLibrary()
  prepare?.(useLibraryStore())
  const wrapper = mount(HomeView, {
    global: {
      plugins: [vuetify, i18n, router],
      // SimilarArtistsShelf stays real — its rendered text is what tells
      // the personal set apart from the community one.
      stubs: { AlbumShelf: true, SongTable: true, CoverArt: true, HeroBand: true },
      mocks: { $emitter: emitter },
    },
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

/** The community "New artists to explore" shelf, found by title so it is
 * never confused with anything else on the page. */
function artistsShelf(wrapper: Awaited<ReturnType<typeof mountHome>>) {
  return wrapper
    .findAllComponents(SimilarArtistsShelf)
    .find((shelf) => shelf.props('title') === wrapper.vm.$t('home.newArtistsTitle'))
}

function ownedArtist(name: string): Artist {
  return {
    id: `owned-${name}`,
    name,
    albumCount: 1,
    coverArtId: null,
    imageUrl: null,
    starred: false,
    rating: 0,
    albums: [],
  }
}

function album(id: string, artist: string): Album {
  return {
    id,
    name: `Album ${id}`,
    artist,
    artistId: `ar-${id}`,
    coverArtId: null,
    songCount: 1,
    duration: 100,
    year: 2024,
    genre: null,
    starred: false,
    rating: 0,
    songs: [],
  }
}

/** Enough distinct artists to clear MIN_SEED_ARTISTS, so the community
 * lookup path actually runs instead of falling straight through to random
 * albums. */
function seedAlbums(): Album[] {
  return [0, 1, 2, 3].map((i) => album(`seed-${i}`, `Artist ${i}`))
}

/** The Reroll control, told apart from CardShelf's own scroll buttons by
 * its title. */
function rerollButton(wrapper: Awaited<ReturnType<typeof mountHome>>) {
  return artistsShelf(wrapper)?.find(`[title="${wrapper.vm.$t('home.reroll')}"]`)
}

describe('HomeView personalized Discover', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
    vi.mocked(getListenbrainzArtists).mockResolvedValue([])
    vi.mocked(getSimilarArtists).mockResolvedValue([])
  })

  it('leaves the community lookup in charge without a ListenBrainz name', async () => {
    vi.mocked(getSimilarArtists).mockResolvedValue([{ name: 'Community Act', mbid: 'c', score: 1 }])

    const wrapper = await mountHome((library) => {
      vi.spyOn(library, 'fetchFrequentAlbums').mockResolvedValue(seedAlbums())
    })
    await flushPromises()

    expect(getListenbrainzArtists).not.toHaveBeenCalled()
    expect(getSimilarArtists).toHaveBeenCalled()
    // The community set is rerollable, so the control stays.
    expect(rerollButton(wrapper)?.exists()).toBe(true)
  })

  it('fills both shelves from the listener’s own recommendations', async () => {
    useListenbrainzStore().setUsername('listener')
    vi.mocked(getListenbrainzArtists).mockResolvedValue([
      { name: 'New Act', mbid: 'n', score: 3 },
      { name: 'Owned Act', mbid: 'o', score: 2 },
    ])

    const wrapper = await mountHome((library) => {
      library.artists = [ownedArtist('Owned Act')]
      vi.spyOn(library, 'fetchArtist').mockResolvedValue({
        ...ownedArtist('Owned Act'),
        albums: [album('a1', 'Owned Act')],
      })
    })
    await flushPromises()

    expect(getListenbrainzArtists).toHaveBeenCalledWith('listener', 30)
    // The owned recommendation contributes one of its albums to the
    // albums shelf ...
    expect((wrapper.vm as unknown as { randomAlbums: Album[] }).randomAlbums).toEqual([
      album('a1', 'Owned Act'),
    ])
    // ... and the not-owned one fills the artists shelf, not the other way
    // round.
    const shelf = artistsShelf(wrapper)
    expect(shelf?.text()).toContain('New Act')
    expect(shelf?.text()).not.toContain('Owned Act')
    // The community lookup never ran for a personalized page.
    expect(getSimilarArtists).not.toHaveBeenCalled()
  })

  it('hides the Reroll buttons while the personal recommendations are shown', async () => {
    useListenbrainzStore().setUsername('listener')
    vi.mocked(getListenbrainzArtists).mockResolvedValue([{ name: 'New Act', mbid: 'n', score: 3 }])

    const wrapper = await mountHome()
    await flushPromises()

    // The shelf itself is there — it is the Reroll control that is gone,
    // because there is nothing to reroll.
    expect(artistsShelf(wrapper)?.text()).toContain('New Act')
    expect(rerollButton(wrapper)?.exists()).toBe(false)
  })

  it('falls back to the community lookup when the personal feed is empty', async () => {
    // A brand-new ListenBrainz account has no recommendations yet — the
    // shelves should still fill the way they do without a name, Reroll
    // button included.
    useListenbrainzStore().setUsername('listener')
    vi.mocked(getListenbrainzArtists).mockResolvedValue([])
    vi.mocked(getSimilarArtists).mockResolvedValue([{ name: 'Community Act', mbid: 'c', score: 1 }])

    const wrapper = await mountHome((library) => {
      vi.spyOn(library, 'fetchFrequentAlbums').mockResolvedValue(seedAlbums())
    })
    await flushPromises()

    expect(getListenbrainzArtists).toHaveBeenCalled()
    expect(getSimilarArtists).toHaveBeenCalled()
    expect(artistsShelf(wrapper)?.text()).toContain('Community Act')
    expect(rerollButton(wrapper)?.exists()).toBe(true)
  })

  it('leaves both shelves empty when the lookup fails, rather than breaking Home', async () => {
    useListenbrainzStore().setUsername('listener')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getListenbrainzArtists).mockRejectedValue(new Error('offline'))

    const wrapper = await mountHome()
    await flushPromises()

    expect((wrapper.vm as unknown as { randomAlbums: Album[] }).randomAlbums).toEqual([])
    expect(
      (wrapper.vm as unknown as { newArtistDiscoveries: unknown[] }).newArtistDiscoveries,
    ).toEqual([])
  })
})
