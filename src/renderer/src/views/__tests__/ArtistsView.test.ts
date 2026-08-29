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
import ArtistsView from '../ArtistsView.vue'

// Reversing stand-in: a real shuffle is random, so passing the list through
// unshuffled would be indistinguishable from a shuffled one that happened
// to come back in order.
vi.mock('@/services/shuffle', () => ({ shuffled: vi.fn((list: Song[]) => [...list].reverse()) }))

const vuetify = createVuetify({ components, directives })

interface ArtistsVm {
  gridWidth: number
  visibleCount: number
  filterQuery: string
  debouncedQuery: string
  playingRandomArtist: boolean
  playingTopArtist: boolean
  readonly filteredArtists: Artist[]
  readonly visibleArtists: Artist[]
  readonly virtualizeArtists: boolean
  readonly columns: number
  readonly artistRows: Artist[][]
  readonly availableLetters: Set<string>
  loadMore(): void
  jumpToLetter(letter: string): void
  playRandomArtist(): Promise<void>
  playTopArtist(): Promise<void>
}

function artist(id: string, name: string): Artist {
  return { id, name, albumCount: 1, coverArtId: null, imageUrl: null, starred: false } as Artist
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
}

async function mountArtists(artists: Artist[]) {
  const store = useLibraryStore()
  store.fetchArtists = vi.fn().mockResolvedValue(undefined)
  store.artists = artists

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
  return { wrapper, store, vm: wrapper.vm as unknown as ArtistsVm }
}

const many = (n: number): Artist[] =>
  Array.from({ length: n }, (_, i) => artist(`a${i}`, `Artist ${String(i).padStart(4, '0')}`))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ArtistsView grid columns', () => {
  it('fits one more card exactly at the width where it starts to fit', async () => {
    const { vm } = await mountArtists(many(10))

    // 160px cards with a 20px gap: the third only fits from 520px on. The
    // albums grid shares these values (it used to differ, see its own
    // "same widths as the artists grid" test), so a change to one of the
    // two constants shows up here as a wrong column count.
    vm.gridWidth = 519
    expect(vm.columns).toBe(2)
    vm.gridWidth = 520
    expect(vm.columns).toBe(3)
  })

  it('falls back to a single column before the width is known', async () => {
    const { vm } = await mountArtists(many(10))

    vm.gridWidth = 0
    expect(vm.columns).toBe(1)
    // Narrower than one card still has to render that one card.
    vm.gridWidth = 50
    expect(vm.columns).toBe(1)
  })
})

describe('ArtistsView paging and filtering', () => {
  it('renders only the first page until asked for more', async () => {
    const { vm } = await mountArtists(many(200))

    expect(vm.visibleArtists).toHaveLength(60)
    vm.loadMore()
    expect(vm.visibleArtists).toHaveLength(120)
  })

  it('never renders more rows than there are artists', async () => {
    const { vm } = await mountArtists(many(5))

    vm.loadMore()

    expect(vm.visibleArtists).toHaveLength(5)
  })

  it('filters over the whole library, not just the loaded page', async () => {
    const { vm } = await mountArtists([...many(100), artist('zz', 'Zappa')])

    vm.debouncedQuery = 'Zappa'

    // The match sits well past the first page; a filter applied to the
    // rendered slice only would find nothing.
    expect(vm.filteredArtists.map((a) => a.id)).toEqual(['zz'])
  })

  it('waits a beat before filtering, then resets paging', async () => {
    vi.useFakeTimers()
    const { vm } = await mountArtists(many(200))
    vm.loadMore()
    expect(vm.visibleCount).toBe(120)

    vm.filterQuery = 'Artist 01'
    await flushPromises()

    // Paging resets immediately so the user is not left deep in a list
    // that just changed underneath them...
    expect(vm.visibleCount).toBe(60)
    // ...while the scan itself waits, so typing stays responsive.
    expect(vm.debouncedQuery).toBe('')
    vi.advanceTimersByTime(200)
    expect(vm.debouncedQuery).toBe('Artist 01')
  })

  it('treats a whitespace-only filter as no filter', async () => {
    const { vm } = await mountArtists(many(10))

    vm.debouncedQuery = '   '

    expect(vm.filteredArtists).toHaveLength(10)
  })
})

describe('ArtistsView virtualization', () => {
  it('switches to rows only past the threshold', async () => {
    const small = await mountArtists(many(500))
    expect(small.vm.virtualizeArtists).toBe(false)
    // Not virtualized means no row chunking is computed at all.
    expect(small.vm.artistRows).toEqual([])

    setActivePinia(createPinia())
    const big = await mountArtists(many(501))
    expect(big.vm.virtualizeArtists).toBe(true)
  })

  it('chunks into rows of the current column count, last row short', async () => {
    const { vm } = await mountArtists(many(505))
    vm.gridWidth = 520 // three columns

    const rows = vm.artistRows

    expect(vm.columns).toBe(3)
    expect(rows).toHaveLength(Math.ceil(505 / 3))
    expect(rows[0]).toHaveLength(3)
    expect(rows[rows.length - 1]).toHaveLength(505 % 3)
    // Every artist appears exactly once across the rows.
    expect(rows.flat()).toHaveLength(505)
  })
})

describe('ArtistsView jump to letter', () => {
  it('pages far enough forward to reach the letter', async () => {
    const { vm } = await mountArtists([...many(100), artist('zz', 'Zappa')])

    vm.jumpToLetter('Z')

    // Zappa sits at index 100, past the first page — jumping there without
    // extending the rendered slice would scroll to nothing.
    expect(vm.visibleCount).toBeGreaterThan(100)
  })

  it('scrolls the virtual list to the row holding the letter', async () => {
    const { vm, wrapper } = await mountArtists([...many(600), artist('zz', 'Zappa')])
    vm.gridWidth = 520 // three columns
    await flushPromises()
    // Spied on the real v-virtual-scroll rather than swapping $refs out:
    // Vue owns that object and re-populates it on every render.
    const virtualScroll = wrapper.findComponent({ name: 'VVirtualScroll' })
    const scrollToIndex = vi.spyOn(
      virtualScroll.vm as unknown as { scrollToIndex: (i: number) => void },
      'scrollToIndex',
    )

    vm.jumpToLetter('Z')

    // Index 600 in a three-column grid is row 200 — passing the item index
    // straight through would land three times too far down.
    expect(scrollToIndex).toHaveBeenCalledWith(200)
  })

  it('does nothing for a letter no artist starts with', async () => {
    const { vm } = await mountArtists(many(100))
    const before = vm.visibleCount

    vm.jumpToLetter('Q')

    expect(vm.visibleCount).toBe(before)
    expect(vm.availableLetters.has('Q')).toBe(false)
  })
})

describe('ArtistsView random playback', () => {
  async function setupPlay(songs: Song[] = [makeSong('1'), makeSong('2'), makeSong('3')]) {
    const { vm, store } = await mountArtists(many(3))
    const playback = usePlaybackStore()
    playback.playSongList = vi.fn().mockResolvedValue(undefined)
    store.fetchArtist = vi.fn().mockResolvedValue({ ...artist('a0', 'A'), albums: [] })
    store.fetchAllSongsForArtist = vi.fn().mockResolvedValue(songs)
    store.fetchFrequentAlbums = vi.fn().mockResolvedValue([])
    return { vm, store, playback }
  }

  it('plays an artist catalogue shuffled', async () => {
    const { vm, playback } = await setupPlay()

    await vm.playRandomArtist()

    // An artist's songs span several separately-sequenced albums, so there
    // is no natural order across them — unlike a single album, which
    // AlbumsView deliberately plays in track order.
    const passed = vi.mocked(playback.playSongList).mock.calls[0]?.[0] as Song[]
    expect(passed.map((s) => s.id)).toEqual(['3', '2', '1'])
  })

  it('ignores a second click while the first is still loading', async () => {
    const { vm, store } = await setupPlay()
    let release: () => void = () => {}
    vi.mocked(store.fetchArtist).mockReturnValue(
      new Promise((r) => (release = () => r({ ...artist('a0', 'A'), albums: [] }))),
    )

    const first = vm.playRandomArtist()
    await vm.playRandomArtist()
    release()
    await first

    expect(store.fetchArtist).toHaveBeenCalledTimes(1)
  })

  it('does nothing with an empty library', async () => {
    const { vm } = await mountArtists([])
    const playback = usePlaybackStore()
    playback.playSongList = vi.fn()

    await vm.playRandomArtist()

    expect(playback.playSongList).not.toHaveBeenCalled()
    expect(vm.playingRandomArtist).toBe(false)
  })

  it('plays nothing rather than an empty queue when the artist has no songs', async () => {
    const { vm, playback } = await setupPlay([])

    await vm.playRandomArtist()

    expect(playback.playSongList).not.toHaveBeenCalled()
  })

  it('picks a top artist from distinct artists behind the top albums', async () => {
    const { vm, store } = await setupPlay()
    // Three top albums, two of them by the same artist.
    vi.mocked(store.fetchFrequentAlbums).mockResolvedValue([
      { artistId: 'x' } as Album,
      { artistId: 'x' } as Album,
      { artistId: 'y' } as Album,
    ])
    // Mid-range on purpose: over the deduped ['x','y'] this lands on 'y',
    // over the raw ['x','x','y'] it lands on 'x'. At the top of the range
    // both would resolve to 'y' and the duplicate would go unnoticed.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    await vm.playTopArtist()

    expect(store.fetchArtist).toHaveBeenCalledWith('y')
  })

  it('stops cleanly when nothing has been played yet', async () => {
    const { vm, store, playback } = await setupPlay()
    vi.mocked(store.fetchFrequentAlbums).mockResolvedValue([])

    await vm.playTopArtist()

    expect(playback.playSongList).not.toHaveBeenCalled()
    // The button has to become clickable again.
    expect(vm.playingTopArtist).toBe(false)
  })
})
