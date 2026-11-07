// The album page's own backdrop decision: the album artist's Fanart.tv
// background when there is one, the blurred album cover otherwise, held
// back until the lookup answers so it never swaps on screen.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import type { Album } from '@/types/library'
import { getArtistArt, rememberBackground } from '@/services/connect/fanart'
import { useFanartStore } from '@/stores/fanart'
import { getAlbumBio } from '@/services/connect/recommendations'
import { usePlaybackStore } from '@/stores/playback'
import { makeSong } from '@/stores/__tests__/fixtures'
import { getDeezerAlbum, type DeezerAlbumTrack } from '@/services/connect/deezer'
import AlbumDetailView from '../AlbumDetailView.vue'

vi.mock('@/services/connect/fanart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/connect/fanart')>()),
  getArtistArt: vi.fn().mockResolvedValue(null),
  rememberBackground: vi.fn(),
}))

vi.mock('@/services/connect/deezer', () => ({ getDeezerAlbum: vi.fn() }))

vi.mock('@/services/connect/recommendations', () => ({
  getAlbumBio: vi.fn().mockResolvedValue(null),
}))

// jsdom never fires an image's load event, so the real one would leave the
// backdrop waiting forever.
vi.mock('@/services/preloadImage', () => ({ preloadImage: vi.fn().mockResolvedValue(undefined) }))

const vuetify = createVuetify({ components, directives })
const toasts = { emit: vi.fn(), on: vi.fn(), off: vi.fn() }

interface AlbumVm {
  album: Album | null
  artistArt: { background: string | null; logo: string | null; banner: string | null } | null
  readonly backdropUrl: string | null
  readonly backdropIsPhoto: boolean
  readonly canCycleBackground: boolean
  cycleBackground(): Promise<void>
  readonly metaLine: string
  readonly releaseTypeLabel: string
  readonly tags: string[]
  bio: { text: string } | null
  loadAlbum(): Promise<void>
  playAll(): Promise<void>
  toggleMissing(): Promise<void>
  readonly previewSongs: { id: string }[]
}

function makeAlbum(overrides: Partial<Album> = {}): Album {
  return {
    id: 'al1',
    name: 'Album One',
    artist: 'Artist One',
    artistId: 'a1',
    coverArtId: 'cover1',
    songCount: 3,
    duration: 0,
    year: 2020,
    genre: null,
    starred: false,
    rating: 0,
    songs: [],
    ...overrides,
  } as Album
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/albums/:id', component: { template: '<div />' } },
    ],
  })
}

async function mountAlbum(album: Album | null) {
  const store = useLibraryStore()
  store.fetchAlbum = vi.fn().mockResolvedValue(album)
  vi.spyOn(store, 'client').mockReturnValue({
    coverArtUrl: (id: string, size: number) => `https://cover/${id}?size=${size}`,
  } as unknown as ReturnType<typeof store.client>)

  const router = makeRouter()
  await router.push('/albums/al1')
  await router.isReady()

  const wrapper = mount(AlbumDetailView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { DetailHero: true, SongTable: true, PageLoader: true },
      mocks: { $emitter: toasts },
    },
  })
  await flushPromises()
  return { wrapper, store, router, vm: wrapper.vm as unknown as AlbumVm }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  ;(i18n.global.locale as unknown as string) = 'en'
  vi.mocked(getArtistArt).mockReset().mockResolvedValue(null)
})

describe('AlbumDetailView Fanart.tv backdrop', () => {
  it('steps to the next background and remembers it for the artist', async () => {
    vi.mocked(getArtistArt).mockResolvedValue({
      banner: null,
      background: 'bg1',
      backgrounds: ['bg1', 'bg2'],
      logo: null,
    })
    const { vm } = await mountAlbum(makeAlbum())

    expect(vm.canCycleBackground).toBe(true)
    await vm.cycleBackground()

    expect(vm.backdropUrl).toBe('bg2')
    // What the artist page and Now Playing open with next.
    expect(rememberBackground).toHaveBeenCalledWith('Artist One', 'bg2')
  })

  it('offers no cycle button with a single background', async () => {
    vi.mocked(getArtistArt).mockResolvedValue({
      banner: null,
      background: 'bg1',
      backgrounds: ['bg1'],
      logo: null,
    })
    const { vm } = await mountAlbum(makeAlbum())

    expect(vm.canCycleBackground).toBe(false)
  })

  it("uses the album artist's background when Fanart.tv has one", async () => {
    vi.mocked(getArtistArt).mockResolvedValue({
      banner: null,
      background: 'https://assets.fanart.tv/bg.jpg',
      backgrounds: [],
      logo: null,
    })

    const { vm } = await mountAlbum(makeAlbum())

    expect(getArtistArt).toHaveBeenCalledWith('Artist One')
    expect(vm.backdropUrl).toBe('https://assets.fanart.tv/bg.jpg')
    expect(vm.backdropIsPhoto).toBe(true)
  })

  it('falls back to the blurred album cover when Fanart.tv has nothing', async () => {
    const { vm } = await mountAlbum(makeAlbum())

    expect(vm.artistArt).toBeNull()
    expect(vm.backdropUrl).toBe('https://cover/cover1?size=300')
    expect(vm.backdropIsPhoto).toBe(false)
  })

  it('falls back to the blurred cover when the lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getArtistArt).mockRejectedValue(new Error('offline'))

    const { vm } = await mountAlbum(makeAlbum())

    expect(vm.artistArt).toBeNull()
    expect(vm.backdropUrl).toBe('https://cover/cover1?size=300')
  })

  it('does not look anything up when Fanart.tv is switched off', async () => {
    useFanartStore().enabled = false
    vi.mocked(getArtistArt).mockResolvedValue({
      banner: null,
      background: 'https://assets.fanart.tv/bg.jpg',
      backgrounds: [],
      logo: null,
    })

    const { vm } = await mountAlbum(makeAlbum())

    expect(getArtistArt).not.toHaveBeenCalled()
    expect(vm.artistArt).toBeNull()
    expect(vm.backdropUrl).toBe('https://cover/cover1?size=300')
  })

  it('holds the backdrop back until the lookup answers', async () => {
    // The point: no cover-then-background swap. The page shows no backdrop
    // until the answer is in, then fades the right one in.
    vi.mocked(getArtistArt).mockReturnValue(new Promise(() => {}))

    const { vm } = await mountAlbum(makeAlbum())

    expect(vm.backdropUrl).toBeNull()
  })

  it('drops the background when Fanart.tv is turned off while open', async () => {
    vi.mocked(getArtistArt).mockResolvedValue({
      banner: null,
      background: 'https://assets.fanart.tv/bg.jpg',
      backgrounds: [],
      logo: null,
    })
    const { vm } = await mountAlbum(makeAlbum())
    expect(vm.backdropUrl).toBe('https://assets.fanart.tv/bg.jpg')

    useFanartStore().enabled = false
    await flushPromises()

    expect(vm.backdropUrl).toBe('https://cover/cover1?size=300')
  })

  it('discards a background that arrives after the route moved on', async () => {
    const store = useLibraryStore()
    store.fetchAlbum = vi
      .fn()
      .mockImplementation((id: string) => Promise.resolve(makeAlbum({ id, name: `Album ${id}` })))
    vi.spyOn(store, 'client').mockReturnValue({
      coverArtUrl: (id: string, size: number) => `https://cover/${id}?size=${size}`,
    } as unknown as ReturnType<typeof store.client>)
    // Only the first lookup (the one started under al1) is held open.
    let resolveStale: (art: Awaited<ReturnType<typeof getArtistArt>>) => void = () => {}
    vi.mocked(getArtistArt).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveStale = r
        }),
    )

    const router = makeRouter()
    await router.push('/albums/al1')
    await router.isReady()
    const wrapper = mount(AlbumDetailView, {
      global: {
        plugins: [vuetify, i18n, router],
        stubs: { DetailHero: true, SongTable: true, PageLoader: true },
      },
    })
    await flushPromises()

    await router.push('/albums/al2')
    await flushPromises()
    resolveStale({
      banner: null,
      background: 'https://assets.fanart.tv/stale.jpg',
      backgrounds: [],
      logo: null,
    })
    await flushPromises()

    const vm = wrapper.vm as unknown as AlbumVm
    // The image belongs to the album the user already left; showing it under
    // the new one would attribute it to the wrong artist.
    expect(vm.artistArt).toBeNull()
    expect(vm.backdropUrl).toBe('https://cover/cover1?size=300')
  })
})

describe('AlbumDetailView header', () => {
  const songs = [
    makeSong('s1', { duration: 1800 }),
    makeSong('s2', { duration: 1800 }),
    makeSong('s3', { duration: 1580 }),
  ]

  it('plays the whole album from its first track', async () => {
    const { vm } = await mountAlbum(makeAlbum({ songs }))
    const playback = usePlaybackStore()
    const play = vi.spyOn(playback, 'playSongList').mockResolvedValue()

    await vm.playAll()

    expect(play).toHaveBeenCalledWith(songs, 0, false, true)
  })

  it('sums the running time from the tracks', async () => {
    // The album's own duration stays 0 here, as a bridge may send it.
    const { vm } = await mountAlbum(makeAlbum({ songs, genre: 'Pop' }))

    expect(vm.metaLine).toBe('2020 · 3 songs · 1 hr 26 min · Pop')
  })

  it('names the kind of release over the title, and falls back to "Album"', async () => {
    const { vm } = await mountAlbum(makeAlbum({ releaseTypes: ['album', 'compilation', 'dj-mix'] }))
    expect(vm.releaseTypeLabel).toBe('Album · Compilation · DJ mix')

    const plain = await mountAlbum(makeAlbum({ releaseTypes: [] }))
    expect(plain.vm.releaseTypeLabel).toBe('Album')
  })

  it('shows a release type it has no word for as the server spells it', async () => {
    const { vm } = await mountAlbum(makeAlbum({ releaseTypes: ['audiobook'] }))
    expect(vm.releaseTypeLabel).toBe('Audiobook')
  })

  it('tags the label, edition and reissue year', async () => {
    const { vm } = await mountAlbum(
      makeAlbum({ labels: ['Island'], version: 'Deluxe Edition', reissueYear: 2011 }),
    )
    expect(vm.tags).toEqual(['Island', 'Deluxe Edition', 'Reissue 2011'])
  })

  it('dates the album by its original release and lists its first genres', async () => {
    const { vm } = await mountAlbum(
      makeAlbum({
        songs,
        year: 2011,
        originalYear: 2008,
        genres: ['Pop', 'Dance', 'Electropop', 'Synth-pop'],
      }),
    )
    expect(vm.metaLine).toBe('2008 · 3 songs · 1 hr 26 min · Pop, Dance, Electropop')
  })

  it("looks the album's Wikipedia paragraph up by what the server knows it as", async () => {
    vi.mocked(getAlbumBio).mockResolvedValue({ text: 'An album.', url: null, lang: 'en' })

    const { vm } = await mountAlbum(makeAlbum({ musicBrainzId: 'rel-1', releaseTypes: ['album'] }))

    expect(getAlbumBio).toHaveBeenCalledWith(
      expect.objectContaining({
        artist: 'Artist One',
        name: 'Album One',
        musicBrainzId: 'rel-1',
        releaseTypes: ['album'],
        lang: 'en',
      }),
    )
    expect(vm.bio?.text).toBe('An album.')
  })

  it('leaves the paragraph out when the lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getAlbumBio).mockRejectedValue(new Error('offline'))

    const { vm } = await mountAlbum(makeAlbum())

    expect(vm.bio).toBeNull()
  })
})

describe('AlbumDetailView missing tracks', () => {
  const track = (title: string): DeezerAlbumTrack => ({
    title,
    titleShort: title,
    artist: 'Artist One',
    duration: 200,
    discNumber: 1,
    trackNumber: 0,
    deezerId: 1,
    album: 'Album One (Deluxe)',
  })
  const deezerAlbum = (...titles: string[]) => ({
    id: 1,
    title: 'Album One (Deluxe)',
    link: '',
    tracks: titles.map(track),
  })
  const album = () =>
    makeAlbum({ songs: [makeSong('s1', { title: 'One' }), makeSong('s2', { title: 'Three' })] })
  const tableMissing = (wrapper: Awaited<ReturnType<typeof mountAlbum>>['wrapper']) => {
    const edition = wrapper.findComponent({ name: 'SongTable' }).props('edition') as {
      missing: { track: { title: string } }[]
    } | null
    return (edition?.missing ?? []).map((missing) => missing.track.title)
  }

  it('looks the album up on the first click and shows what the library is missing', async () => {
    vi.mocked(getDeezerAlbum).mockResolvedValue(deezerAlbum('One', 'Two', 'Three', 'Bonus'))
    const { wrapper, vm } = await mountAlbum(album())
    expect(getDeezerAlbum).not.toHaveBeenCalled()

    await vm.toggleMissing()
    await flushPromises()

    expect(getDeezerAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ artist: 'Artist One', name: 'Album One' }),
    )
    expect(tableMissing(wrapper)).toEqual(['Two', 'Bonus'])
  })

  it('previews the missing tracks too while they are shown', async () => {
    vi.mocked(getDeezerAlbum).mockResolvedValue(deezerAlbum('One', 'Two', 'Three'))
    const { vm } = await mountAlbum(album())
    const previewed = () => vm.previewSongs.map((song) => song.id)
    expect(previewed()).toEqual(['s1', 's2'])

    await vm.toggleMissing()
    await flushPromises()
    expect(previewed()).toEqual(['s1', 'deezer:1', 's2'])

    await vm.toggleMissing()
    await flushPromises()
    expect(previewed()).toEqual(['s1', 's2'])
  })

  it('hides them again on the next click and shows them without asking twice', async () => {
    vi.mocked(getDeezerAlbum).mockResolvedValue(deezerAlbum('One', 'Two', 'Three'))
    const { wrapper, vm } = await mountAlbum(album())

    await vm.toggleMissing()
    await vm.toggleMissing()
    await flushPromises()
    expect(tableMissing(wrapper)).toEqual([])

    await vm.toggleMissing()
    await flushPromises()
    expect(tableMissing(wrapper)).toEqual(['Two'])
    expect(getDeezerAlbum).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the album is complete', () => Promise.resolve(deezerAlbum('One', 'Three')), 'information'],
    ['Deezer does not carry it', () => Promise.resolve(null), 'information'],
    ['the lookup fails', () => Promise.reject(new Error('502')), 'error'],
  ])('says so and shows nothing when %s', async (_case, answer, level) => {
    vi.mocked(getDeezerAlbum).mockImplementation(answer)
    const { wrapper, vm } = await mountAlbum(album())

    await vm.toggleMissing()
    await flushPromises()

    expect(tableMissing(wrapper)).toEqual([])
    expect(toasts.emit).toHaveBeenCalledWith('toast', expect.objectContaining({ level }))
  })

  it('drops an answer for an album the page has since left', async () => {
    let answer!: (value: ReturnType<typeof deezerAlbum>) => void
    vi.mocked(getDeezerAlbum).mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { wrapper, vm, store } = await mountAlbum(album())

    const pending = vm.toggleMissing()
    store.fetchAlbum = vi.fn().mockResolvedValue(makeAlbum({ id: 'al2', songs: [] }))
    await vm.loadAlbum()
    answer(deezerAlbum('One', 'Two', 'Three'))
    await pending
    await flushPromises()

    expect(tableMissing(wrapper)).toEqual([])
  })
})
