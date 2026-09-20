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
import { getArtistArt } from '@/services/connect/fanart'
import { useFanartStore } from '@/stores/fanart'
import AlbumDetailView from '../AlbumDetailView.vue'

vi.mock('@/services/connect/fanart', () => ({
  getArtistArt: vi.fn().mockResolvedValue(null),
}))

// jsdom never fires an image's load event, so the real one would leave the
// backdrop waiting forever.
vi.mock('@/services/preloadImage', () => ({ preloadImage: vi.fn().mockResolvedValue(undefined) }))

const vuetify = createVuetify({ components, directives })

interface AlbumVm {
  album: Album | null
  artistArt: { background: string | null; logo: string | null; banner: string | null } | null
  readonly backdropUrl: string | null
  readonly backdropIsPhoto: boolean
  loadAlbum(): Promise<void>
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
  it("uses the album artist's background when Fanart.tv has one", async () => {
    vi.mocked(getArtistArt).mockResolvedValue({
      banner: null,
      background: 'https://assets.fanart.tv/bg.jpg',
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
    resolveStale({ banner: null, background: 'https://assets.fanart.tv/stale.jpg', logo: null })
    await flushPromises()

    const vm = wrapper.vm as unknown as AlbumVm
    // The image belongs to the album the user already left; showing it under
    // the new one would attribute it to the wrong artist.
    expect(vm.artistArt).toBeNull()
    expect(vm.backdropUrl).toBe('https://cover/cover1?size=300')
  })
})
