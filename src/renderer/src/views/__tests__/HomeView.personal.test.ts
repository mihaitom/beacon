// Home's personalized "Recommended for you" shelf: the artists behind the
// listener's own ListenBrainz recommendations (see
// core/listenbrainz.py's get_recommended_artists), enriched and shown the
// same way the community "New artists to explore" shelf is.
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
import type { Artist } from '@/types/library'

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
      stubs: { AlbumShelf: true, SongTable: true, CoverArt: true, HeroBand: true },
      mocks: { $emitter: emitter },
    },
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

/** The personalized shelf, not the community one — Home renders two
 * SimilarArtistsShelf instances, distinguished by their title. */
function personalShelf(wrapper: Awaited<ReturnType<typeof mountHome>>) {
  return wrapper
    .findAllComponents(SimilarArtistsShelf)
    .find((shelf) => shelf.props('title') === wrapper.vm.$t('home.recommendedArtists'))
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

describe('HomeView personalized recommendations', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
    vi.mocked(getListenbrainzArtists).mockResolvedValue([])
  })

  it('does not ask without a ListenBrainz name', async () => {
    await mountHome()
    await flushPromises()

    expect(getListenbrainzArtists).not.toHaveBeenCalled()
  })

  it('asks for the listener’s artists and shows the ones not owned', async () => {
    useListenbrainzStore().setUsername('listener')
    vi.mocked(getListenbrainzArtists).mockResolvedValue([
      { name: 'New Act', mbid: 'n', score: 3 },
      { name: 'Owned Act', mbid: 'o', score: 2 },
    ])

    const wrapper = await mountHome((library) => {
      library.artists = [ownedArtist('Owned Act')]
    })
    await flushPromises()

    expect(getListenbrainzArtists).toHaveBeenCalledWith('listener', 30)
    const shelf = personalShelf(wrapper)
    expect(shelf?.text()).toContain('New Act')
    expect(shelf?.text()).not.toContain('Owned Act')
  })

  it('stays hidden when the lookup fails, rather than breaking Home', async () => {
    useListenbrainzStore().setUsername('listener')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getListenbrainzArtists).mockRejectedValue(new Error('offline'))

    const wrapper = await mountHome()
    await flushPromises()

    expect(personalShelf(wrapper)?.text()).not.toContain('New Act')
  })
})
