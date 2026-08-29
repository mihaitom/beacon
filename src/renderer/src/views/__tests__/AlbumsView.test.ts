import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import type { Album, Artist, Song } from '@/types/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import AlbumsView from '../AlbumsView.vue'
import ArtistsView from '../ArtistsView.vue'

const vuetify = createVuetify({ components, directives })

interface AlbumsVm {
  gridWidth: number
  visibleCount: number
  filterQuery: string
  debouncedQuery: string
  playingRandomAlbum: boolean
  playingTopAlbum: boolean
  readonly filteredAlbums: Album[]
  readonly visibleAlbums: Album[]
  readonly virtualizeAlbums: boolean
  readonly columns: number
  readonly albumRows: Album[][]
  loadMore(): void
  jumpToLetter(letter: string): void
  playRandomAlbum(): Promise<void>
  playTopAlbum(): Promise<void>
}

function album(id: string, name: string): Album {
  return {
    id,
    name,
    artist: 'A',
    artistId: 'a1',
    coverArtId: null,
    songCount: 1,
    duration: 0,
    year: 2000,
    genre: null,
    starred: false,
    rating: 0,
  } as Album
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
}

async function mountAlbums(albums: Album[]) {
  const store = useLibraryStore()
  store.fetchAlbums = vi.fn().mockResolvedValue(undefined)
  store.albums = albums

  const router = makeRouter()
  await router.push('/')
  await router.isReady()

  const wrapper = mount(AlbumsView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: {
        DetailHeader: true,
        AlbumCard: true,
        AlphabetIndexBar: true,
        InfiniteScrollTrigger: true,
        StickyFilter: true,
      },
    },
  })
  await flushPromises()
  return { wrapper, store, vm: wrapper.vm as unknown as AlbumsVm }
}

/** Mounts the artists grid purely to read its column count — the two views
 * have to agree on where a column breaks (see the test that uses this). */
async function mountArtistsGrid(): Promise<{ gridWidth: number; readonly columns: number }> {
  const store = useLibraryStore()
  store.fetchArtists = vi.fn().mockResolvedValue(undefined)
  store.artists = Array.from(
    { length: 10 },
    (_, i) => ({ id: `a${i}`, name: `Artist ${i}`, albumCount: 1 }) as Artist,
  )
  const router = makeRouter()
  await router.push('/')
  await router.isReady()
  const wrapper = mount(ArtistsView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: {
        DetailHeader: true,
        ArtistCard: true,
        AlphabetIndexBar: true,
        InfiniteScrollTrigger: true,
        StickyFilter: true,
      },
    },
  })
  await flushPromises()
  return wrapper.vm as unknown as { gridWidth: number; readonly columns: number }
}

const many = (n: number): Album[] =>
  Array.from({ length: n }, (_, i) => album(`al${i}`, `Album ${String(i).padStart(4, '0')}`))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AlbumsView grid columns', () => {
  it('fits one more card exactly at the width where it starts to fit', async () => {
    const { vm } = await mountAlbums(many(10))

    // 160px cards with a 20px gap: the third only fits from 520px on.
    vm.gridWidth = 519
    expect(vm.columns).toBe(2)
    vm.gridWidth = 520
    expect(vm.columns).toBe(3)
  })

  it('breaks columns at the same widths as the artists grid', async () => {
    const { vm } = await mountAlbums(many(10))
    const artistsVm = await mountArtistsGrid()

    // Both grids lay out the same 160px cards, so they have to agree on
    // where a column breaks. They did not: this grid used a 16px gap and
    // switched at 512 while the shelves and the artists grid used 20px and
    // switched at 520 — the same AlbumCards sat closer together here than
    // on the shelves. Compared across the boundary rather than asserting a
    // number, so this keeps holding if the shared card size ever changes.
    for (const width of [300, 400, 511, 512, 519, 520, 700, 1024]) {
      vm.gridWidth = width
      artistsVm.gridWidth = width
      expect(vm.columns).toBe(artistsVm.columns)
    }
  })

  it('falls back to a single column before the width is known', async () => {
    const { vm } = await mountAlbums(many(10))

    vm.gridWidth = 0

    expect(vm.columns).toBe(1)
  })
})

describe('AlbumsView paging and filtering', () => {
  it('renders only the first page until asked for more', async () => {
    const { vm } = await mountAlbums(many(200))

    expect(vm.visibleAlbums).toHaveLength(60)
    vm.loadMore()
    expect(vm.visibleAlbums).toHaveLength(120)
  })

  it('filters over the whole library, not just the loaded page', async () => {
    const { vm } = await mountAlbums([...many(100), album('zz', 'Zenith')])

    vm.debouncedQuery = 'Zenith'

    expect(vm.filteredAlbums.map((a) => a.id)).toEqual(['zz'])
  })

  it('waits a beat before filtering, then resets paging', async () => {
    vi.useFakeTimers()
    const { vm } = await mountAlbums(many(200))
    vm.loadMore()

    vm.filterQuery = 'Album 01'
    await flushPromises()

    expect(vm.visibleCount).toBe(60)
    expect(vm.debouncedQuery).toBe('')
    vi.advanceTimersByTime(200)
    expect(vm.debouncedQuery).toBe('Album 01')
  })
})

describe('AlbumsView virtualization', () => {
  it('switches to rows only past the threshold', async () => {
    const small = await mountAlbums(many(500))
    expect(small.vm.virtualizeAlbums).toBe(false)
    expect(small.vm.albumRows).toEqual([])

    setActivePinia(createPinia())
    const big = await mountAlbums(many(501))
    expect(big.vm.virtualizeAlbums).toBe(true)
  })

  it('chunks into rows of the current column count, last row short', async () => {
    const { vm } = await mountAlbums(many(505))
    vm.gridWidth = 520 // three columns

    const rows = vm.albumRows

    expect(vm.columns).toBe(3)
    expect(rows).toHaveLength(Math.ceil(505 / 3))
    expect(rows[rows.length - 1]).toHaveLength(505 % 3)
    expect(rows.flat()).toHaveLength(505)
  })
})

describe('AlbumsView jump to letter', () => {
  it('pages far enough forward to reach the letter', async () => {
    const { vm } = await mountAlbums([...many(100), album('zz', 'Zenith')])

    vm.jumpToLetter('Z')

    expect(vm.visibleCount).toBeGreaterThan(100)
  })

  it('scrolls the virtual list to the row holding the letter', async () => {
    const { vm, wrapper } = await mountAlbums([...many(600), album('zz', 'Zenith')])
    vm.gridWidth = 520 // three columns
    await flushPromises()
    const virtualScroll = wrapper.findComponent({ name: 'VVirtualScroll' })
    const scrollToIndex = vi.spyOn(
      virtualScroll.vm as unknown as { scrollToIndex: (i: number) => void },
      'scrollToIndex',
    )

    vm.jumpToLetter('Z')

    // Item 600 across three columns is row 200.
    expect(scrollToIndex).toHaveBeenCalledWith(200)
  })

  it('does nothing for a letter no album starts with', async () => {
    const { vm } = await mountAlbums(many(100))
    const before = vm.visibleCount

    vm.jumpToLetter('Q')

    expect(vm.visibleCount).toBe(before)
  })
})

describe('AlbumsView random playback', () => {
  const tracks: Song[] = [makeSong('t1'), makeSong('t2'), makeSong('t3')]

  async function setupPlay() {
    const { vm, store } = await mountAlbums(many(3))
    const playback = usePlaybackStore()
    playback.playSongList = vi.fn().mockResolvedValue(undefined)
    store.fetchAlbum = vi.fn().mockResolvedValue({ ...album('al0', 'Album 0000'), songs: tracks })
    store.fetchFrequentAlbums = vi.fn().mockResolvedValue([])
    return { vm, store, playback }
  }

  it('plays an album in its own track order, not shuffled', async () => {
    const { vm, playback } = await setupPlay()

    await vm.playRandomAlbum()

    // An album is a deliberately sequenced work — unlike an artist's
    // catalogue, which ArtistsView shuffles on purpose.
    expect(vi.mocked(playback.playSongList).mock.calls[0]?.[0]).toEqual(tracks)
  })

  it('ignores a second click while the first is still loading', async () => {
    const { vm, store } = await setupPlay()
    let release: () => void = () => {}
    vi.mocked(store.fetchAlbum).mockReturnValue(
      new Promise((r) => (release = () => r({ ...album('al0', 'A'), songs: tracks }))),
    )

    const first = vm.playRandomAlbum()
    await vm.playRandomAlbum()
    release()
    await first

    expect(store.fetchAlbum).toHaveBeenCalledTimes(1)
  })

  it('does nothing with an empty library', async () => {
    const { vm } = await mountAlbums([])
    const playback = usePlaybackStore()
    playback.playSongList = vi.fn()

    await vm.playRandomAlbum()

    expect(playback.playSongList).not.toHaveBeenCalled()
    expect(vm.playingRandomAlbum).toBe(false)
  })

  it('releases the top-album button when the server returns nothing', async () => {
    const { vm, store, playback } = await setupPlay()
    vi.mocked(store.fetchFrequentAlbums).mockResolvedValue([])

    await vm.playTopAlbum()

    expect(playback.playSongList).not.toHaveBeenCalled()
    expect(vm.playingTopAlbum).toBe(false)
  })

  it('plays a frequently played album when there is one', async () => {
    const { vm, store, playback } = await setupPlay()
    vi.mocked(store.fetchFrequentAlbums).mockResolvedValue([album('top', 'Top Album')])

    await vm.playTopAlbum()

    expect(store.fetchAlbum).toHaveBeenCalledWith('top')
    expect(playback.playSongList).toHaveBeenCalled()
  })
})
