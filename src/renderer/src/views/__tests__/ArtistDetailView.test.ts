import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore, TOP_SONGS_LIMIT } from '@/stores/library'
import type { Album, Song } from '@/types/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import ArtistDetailView from '../ArtistDetailView.vue'

// Fired and forgotten by loadArtist(); a real one would hit the network.
vi.mock('@/services/connect/recommendations', () => ({
  getArtistImages: vi.fn().mockResolvedValue({}),
  getArtistLinks: vi.fn().mockResolvedValue({}),
}))

const vuetify = createVuetify({ components, directives })

type ArtistDetail = Awaited<ReturnType<ReturnType<typeof useLibraryStore>['fetchArtist']>>

interface ArtistVm {
  artist: ArtistDetail | null
  albumSortAscending: boolean
  topSongs: Song[]
  allTopSongs: Song[] | null
  allSongsShown: boolean
  loadingAllSongs: boolean
  readonly totalSongCount: number
  readonly canToggleAllSongs: boolean
  readonly displayedTopSongs: Song[]
  readonly sortedAlbums: Album[]
  loadArtist(): Promise<void>
  toggleAllTopSongs(): Promise<void>
}

function album(id: string, year: number | null, songCount = 1): Album {
  return {
    id,
    name: `Album ${id}`,
    artist: 'A',
    artistId: 'a1',
    coverArtId: null,
    songCount,
    duration: 0,
    year,
    genre: null,
    starred: false,
    rating: 0,
  } as Album
}

function makeArtist(albums: Album[], id = 'a1'): ArtistDetail {
  return { id, name: 'Artist One', albums } as unknown as ArtistDetail
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/artists/:id', component: { template: '<div />' } },
    ],
  })
}

async function mountArtist(artist: ArtistDetail | null, topSongs: Song[] = []) {
  const store = useLibraryStore()
  store.fetchArtist = vi.fn().mockResolvedValue(artist)
  store.fetchTopSongsForArtist = vi.fn().mockResolvedValue(topSongs)

  const router = makeRouter()
  await router.push('/artists/a1')
  await router.isReady()

  const wrapper = mount(ArtistDetailView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { DetailHeader: true, AlbumShelf: true, SongTable: true, PageLoader: true },
    },
  })
  await flushPromises()
  return { wrapper, store, router, vm: wrapper.vm as unknown as ArtistVm }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('ArtistDetailView album sorting', () => {
  it('shows newest first by default', async () => {
    const { vm } = await mountArtist(makeArtist([album('old', 1990), album('new', 2020)]))

    expect(vm.sortedAlbums.map((a) => a.id)).toEqual(['new', 'old'])
  })

  it('reverses to oldest first', async () => {
    const { vm } = await mountArtist(makeArtist([album('old', 1990), album('new', 2020)]))

    vm.albumSortAscending = true

    expect(vm.sortedAlbums.map((a) => a.id)).toEqual(['old', 'new'])
  })

  it('keeps undated albums last in both directions', async () => {
    // Undated entries deliberately seeded first, middle and last: with a
    // comparator that is inconsistent about them, the result depends on the
    // order the sort happens to compare pairs in, and a single undated
    // album at one position can pass by luck.
    const artist = makeArtist([
      album('undated-a', null),
      album('old', 1990),
      album('undated-b', null),
      album('new', 2020),
      album('undated-c', null),
    ])
    const { vm } = await mountArtist(artist)

    const descending = vm.sortedAlbums.map((a) => a.id)
    vm.albumSortAscending = true
    const ascending = vm.sortedAlbums.map((a) => a.id)

    // There is no sensible slot for "unknown" between two known years, so
    // they go last either way round rather than leading the ascending view.
    expect(descending.slice(0, 2)).toEqual(['new', 'old'])
    expect(ascending.slice(0, 2)).toEqual(['old', 'new'])
    for (const order of [descending, ascending]) {
      expect(order.slice(2).sort()).toEqual(['undated-a', 'undated-b', 'undated-c'])
    }
  })

  it('does not mutate the artist album order it was given', async () => {
    const artist = makeArtist([album('old', 1990), album('new', 2020)])
    const { vm } = await mountArtist(artist)

    void vm.sortedAlbums

    // Sorting in place would reorder the store's own object.
    expect(artist.albums.map((a) => a.id)).toEqual(['old', 'new'])
  })
})

describe('ArtistDetailView song count and toggle availability', () => {
  it('adds up songs across every album', async () => {
    const { vm } = await mountArtist(makeArtist([album('x', 2000, 4), album('y', 2001, 7)]))

    expect(vm.totalSongCount).toBe(11)
  })

  it('reports zero while no artist is loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = useLibraryStore()
    store.fetchArtist = vi.fn().mockRejectedValue(new Error('offline'))
    store.fetchTopSongsForArtist = vi.fn().mockResolvedValue([])
    const router = makeRouter()
    await router.push('/artists/a1')
    await router.isReady()
    const wrapper = mount(ArtistDetailView, {
      global: {
        plugins: [vuetify, i18n, router],
        stubs: { DetailHeader: true, AlbumShelf: true, SongTable: true, PageLoader: true },
      },
    })
    await flushPromises()
    const vm = wrapper.vm as unknown as ArtistVm

    expect(vm.artist).toBeNull()
    expect(vm.totalSongCount).toBe(0)
    expect(vm.canToggleAllSongs).toBe(false)
  })

  it('offers "show all" only above the capped limit', async () => {
    const exactly = await mountArtist(makeArtist([album('x', 2000, TOP_SONGS_LIMIT)]))
    expect(exactly.vm.canToggleAllSongs).toBe(false)

    setActivePinia(createPinia())
    const more = await mountArtist(makeArtist([album('x', 2000, TOP_SONGS_LIMIT + 1)]))
    expect(more.vm.canToggleAllSongs).toBe(true)
  })

  it('decides from the album totals, not from what has been fetched', async () => {
    // Comparing against topSongs.length instead would make the button
    // flicker in and out across a toggle.
    const { vm } = await mountArtist(makeArtist([album('x', 2000, 50)]), [makeSong('1')])

    expect(vm.topSongs).toHaveLength(1)
    expect(vm.canToggleAllSongs).toBe(true)
  })
})

describe('ArtistDetailView show-all toggle', () => {
  it('fetches the full list once and reuses it afterwards', async () => {
    const { vm, store } = await mountArtist(makeArtist([album('x', 2000, 50)]), [
      makeSong('capped'),
    ])
    vi.mocked(store.fetchTopSongsForArtist).mockResolvedValue([makeSong('a'), makeSong('b')])

    await vm.toggleAllTopSongs()
    expect(vm.displayedTopSongs).toHaveLength(2)
    const callsAfterFirstOpen = vi.mocked(store.fetchTopSongsForArtist).mock.calls.length

    await vm.toggleAllTopSongs() // collapse
    await vm.toggleAllTopSongs() // expand again

    expect(vm.displayedTopSongs).toHaveLength(2)
    // The cached list is reused; only the first expand may fetch.
    expect(vi.mocked(store.fetchTopSongsForArtist).mock.calls.length).toBe(callsAfterFirstOpen)
  })

  it('falls back to the capped list when collapsed', async () => {
    const { vm, store } = await mountArtist(makeArtist([album('x', 2000, 50)]), [
      makeSong('capped'),
    ])
    vi.mocked(store.fetchTopSongsForArtist).mockResolvedValue([makeSong('a'), makeSong('b')])
    await vm.toggleAllTopSongs()

    await vm.toggleAllTopSongs()

    expect(vm.allSongsShown).toBe(false)
    expect(vm.displayedTopSongs.map((s) => s.id)).toEqual(['capped'])
  })

  it('discards a full-list response that lands after navigating away', async () => {
    const { vm, store, router } = await mountArtist(makeArtist([album('x', 2000, 50)]), [
      makeSong('capped'),
    ])
    let resolveAll: (s: Song[]) => void = () => {}
    vi.mocked(store.fetchTopSongsForArtist).mockReturnValue(
      new Promise<Song[]>((r) => (resolveAll = r)),
    )

    const toggling = vm.toggleAllTopSongs()
    await router.push('/artists/a2')
    await flushPromises()
    resolveAll([makeSong('other-artists-song')])
    await toggling
    await flushPromises()

    // The list belongs to the artist the user left; showing it under the
    // new one would silently attribute someone else's songs to them.
    expect(vm.allTopSongs).toBeNull()
    expect(vm.allSongsShown).toBe(false)
  })

  it('asks for an uncapped fetch, not another capped one', async () => {
    const { vm, store } = await mountArtist(makeArtist([album('x', 2000, 50)]))
    vi.mocked(store.fetchTopSongsForArtist).mockClear()

    await vm.toggleAllTopSongs()

    expect(store.fetchTopSongsForArtist).toHaveBeenCalledWith(expect.anything(), Infinity)
  })
})

describe('ArtistDetailView navigating between artists', () => {
  it('discards a response that arrives after the route moved on', async () => {
    const { vm, store, router } = await mountArtist(makeArtist([album('x', 2000)]))
    let resolveStale: (a: ArtistDetail) => void = () => {}
    // Keyed by id: navigating away re-enters loadArtist() through the route
    // watcher, and that second, legitimate call must get its own answer.
    vi.mocked(store.fetchArtist).mockImplementation((id: string) =>
      id === 'a1'
        ? new Promise<ArtistDetail>((r) => (resolveStale = r))
        : Promise.resolve(makeArtist([album('fresh', 2001)], 'a2')),
    )

    const loading = vm.loadArtist()
    await router.push('/artists/a2')
    await flushPromises()
    resolveStale(makeArtist([album('stale', 1980)], 'a1'))
    await loading
    await flushPromises()

    // The slow response belongs to the artist the user already left; it
    // must not overwrite the one now on screen.
    expect(vm.sortedAlbums.map((a) => a.id)).toEqual(['fresh'])
  })

  it('discards stale top songs too', async () => {
    const { vm, store, router } = await mountArtist(makeArtist([album('x', 2000)]))
    let resolveStaleSongs: (s: Song[]) => void = () => {}
    let seen = 0
    vi.mocked(store.fetchTopSongsForArtist).mockImplementation(() => {
      seen += 1
      // Only the first call (the one started under a1) is held open.
      return seen === 1
        ? new Promise<Song[]>((r) => (resolveStaleSongs = r))
        : Promise.resolve([makeSong('fresh-song')])
    })

    const loading = vm.loadArtist()
    await flushPromises()
    await router.push('/artists/a2')
    await flushPromises()
    resolveStaleSongs([makeSong('stale-song')])
    await loading
    await flushPromises()

    expect(vm.topSongs.map((s) => s.id)).not.toContain('stale-song')
  })

  it('resets the per-artist view state', async () => {
    const { vm, store } = await mountArtist(makeArtist([album('x', 2000, 50)]), [
      makeSong('capped'),
    ])
    vi.mocked(store.fetchTopSongsForArtist).mockResolvedValue([makeSong('a')])
    await vm.toggleAllTopSongs()
    vm.albumSortAscending = true

    await vm.loadArtist()
    await flushPromises()

    // A toggle or sort made on one artist must not carry over to the next.
    expect(vm.allSongsShown).toBe(false)
    expect(vm.allTopSongs).toBeNull()
    expect(vm.albumSortAscending).toBe(false)
  })

  it('keeps the page usable when the artist fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { vm, store } = await mountArtist(makeArtist([album('x', 2000)]))
    vi.mocked(store.fetchArtist).mockRejectedValue(new Error('offline'))

    await vm.loadArtist()

    expect(vm.topSongs).toEqual([])
  })
})
