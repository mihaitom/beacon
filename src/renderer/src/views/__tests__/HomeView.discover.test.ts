// The two Discover shelves are filled by one and the same request (see
// HomeView.vue's discoverFromSimilarArtists), so asking for a fresh set
// has to be reachable from either of them — it used to sit only on the
// albums shelf, leaving "New artists to explore" with no way to ask for
// different suggestions.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useLibraryStore } from '@/stores/library'
import HomeView from '../HomeView.vue'
import SimilarArtistsShelf from '@/components/library/SimilarArtistsShelf.vue'
import { getSimilarArtists } from '@/services/connect/recommendations'

vi.mock('@/services/connect/recommendations', () => ({
  getSimilarArtists: vi.fn(async () => []),
  getArtistImages: vi.fn(async () => ({})),
  getArtistLinksByMbid: vi.fn(async () => ({})),
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

async function mountHome() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/artists/:id', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()
  stubLibrary()
  const wrapper = mount(HomeView, {
    global: {
      plugins: [vuetify, i18n, router],
      // SimilarArtistsShelf stays real — it is the component that has to
      // pass the slot through.
      stubs: { AlbumShelf: true, SongTable: true, CoverArt: true, HeroBand: true },
      mocks: { $emitter: emitter },
    },
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('HomeView "New artists to explore"', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  async function withDiscoveries(wrapper: Awaited<ReturnType<typeof mountHome>>) {
    ;(wrapper.vm as unknown as { newArtistDiscoveries: unknown[] }).newArtistDiscoveries = [
      { name: 'Some Band', mbid: 'x', image: null, links: {} },
    ]
    await wrapper.vm.$nextTick()
  }

  it('offers a button to ask for different artists', async () => {
    const wrapper = await mountHome()
    await withDiscoveries(wrapper)

    const shelf = wrapper.findComponent(SimilarArtistsShelf)
    expect(shelf.exists()).toBe(true)
    expect(shelf.find('button').exists()).toBe(true)
  })

  it('picks new seeds when it is pressed, rather than repeating the last set', async () => {
    const wrapper = await mountHome()
    await withDiscoveries(wrapper)
    const vm = wrapper.vm as unknown as {
      rerollDiscover(albums?: unknown, force?: boolean): Promise<void>
    }
    const reroll = vi.spyOn(vm, 'rerollDiscover').mockResolvedValue()

    await wrapper.findComponent(SimilarArtistsShelf).find('button').trigger('click')

    // force: true — without it the same cached seeds come back and the
    // shelves show what they already showed. 'artists' — the shelf that
    // was actually pressed is the only one that changes.
    expect(reroll).toHaveBeenCalledWith(undefined, true, 'artists')
  })

  it('shows nothing to press while there are no discoveries yet', async () => {
    // The shelf renders nothing at all when empty, button included.
    const wrapper = await mountHome()

    expect(wrapper.findComponent(SimilarArtistsShelf).find('button').exists()).toBe(false)
  })

  it('leaves the albums shelf alone when the artists shelf is rerolled', async () => {
    // One lookup fills both, but replacing a shelf nobody touched is a
    // surprise: press shuffle under the new artists and the albums above
    // would change too, for no visible reason.
    const wrapper = await mountHome()
    await withDiscoveries(wrapper)
    const vm = wrapper.vm as unknown as {
      randomAlbums: unknown[]
      newArtistDiscoveries: unknown[]
      discoverFromSimilarArtists(seeds: string[], only?: 'albums' | 'artists' | null): Promise<void>
    }
    const albumsBefore = [{ id: 'kept' }]
    vm.randomAlbums = albumsBefore

    vi.mocked(getSimilarArtists).mockResolvedValue([{ name: 'Fresh Act', mbid: 'm', score: 1 }])

    await vm.discoverFromSimilarArtists(['Seed'], 'artists')

    // Untouched, contents and all — the albums shelf keeps showing what it
    // showed before the artists shelf was rerolled.
    expect(vm.randomAlbums).toEqual(albumsBefore)
    expect((vm.newArtistDiscoveries[0] as { name: string }).name).toBe('Fresh Act')
  })

  it('shows placeholder cards while it fetches, instead of collapsing', async () => {
    // The shelf renders nothing when it has no artists, so without
    // placeholders it vanished mid-reroll and shoved the page around.
    const wrapper = await mountHome()
    await withDiscoveries(wrapper)
    ;(wrapper.vm as unknown as { loadingDiscover: string | null }).loadingDiscover = 'artists'
    await wrapper.vm.$nextTick()

    const shelf = wrapper.findComponent(SimilarArtistsShelf)
    expect(shelf.exists()).toBe(true)
    expect(shelf.findAll('.v-skeleton-loader').length).toBeGreaterThan(0)
  })

  it("keeps the placeholders out of the albums shelf's way", async () => {
    // Rerolling the albums shelf must not blank the artists one.
    const wrapper = await mountHome()
    await withDiscoveries(wrapper)
    ;(wrapper.vm as unknown as { loadingDiscover: string | null }).loadingDiscover = 'albums'
    await wrapper.vm.$nextTick()

    const shelf = wrapper.findComponent(SimilarArtistsShelf)
    expect(shelf.findAll('.v-skeleton-loader').length).toBe(0)
    expect(shelf.text()).toContain('Some Band')
  })

  it('serves the first shuffle of the other shelf from what the last one kept back', async () => {
    // One lookup produces both halves and takes seconds (MusicBrainz,
    // ListenBrainz, then a photo and links per artist). Spending the half
    // the other shelf didn't use makes its next shuffle instant, and it is
    // still a fresh set — it came from the seeds that lookup picked.
    const wrapper = await mountHome()
    const vm = wrapper.vm as unknown as {
      newArtistDiscoveries: unknown[]
      heldOverArtists: unknown[] | null
      rerollDiscover(a?: unknown, f?: boolean, only?: 'albums' | 'artists'): Promise<void>
    }
    vm.heldOverArtists = [{ name: 'Held Back', mbid: 'h', imageUrl: null, links: {} }]
    vi.mocked(getSimilarArtists).mockClear()

    await vm.rerollDiscover(undefined, true, 'artists')

    expect((vm.newArtistDiscoveries[0] as { name: string }).name).toBe('Held Back')
    expect(getSimilarArtists).not.toHaveBeenCalled()
    // Used once, so the next shuffle has to go and fetch again.
    expect(vm.heldOverArtists).toBeNull()
  })

  it('does a real lookup once the kept-back half is spent', async () => {
    const wrapper = await mountHome()
    const vm = wrapper.vm as unknown as {
      heldOverArtists: unknown[] | null
      frequentAlbums: unknown[]
      rerollDiscover(a?: unknown, f?: boolean, only?: 'albums' | 'artists'): Promise<void>
    }
    vm.heldOverArtists = null
    // Seeds come from the most-played albums, and there is a minimum
    // below which the shelves fall back to plain random albums instead.
    vm.frequentAlbums = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((artist, i) => ({
      id: `album-${i}`,
      name: `Album ${i}`,
      artist,
      artistId: `artist-${i}`,
      coverArtId: null,
      year: 2020,
      songCount: 10,
      duration: 2000,
      genre: null,
      starred: false,
    }))
    vi.mocked(getSimilarArtists).mockClear()
    vi.mocked(getSimilarArtists).mockResolvedValue([{ name: 'Fetched', mbid: 'f', score: 1 }])

    await vm.rerollDiscover(undefined, true, 'artists')

    expect(getSimilarArtists).toHaveBeenCalled()
  })
})
