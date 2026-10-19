// Covers the hero band's own decisions, which HeroBand.vue deliberately
// doesn't make: it renders a Song Radio button when told to, while *when*
// to tell it, and what happens on the click, live here.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useAuthStore } from '@/stores/auth'
import { useHomeStore } from '@/stores/home'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import HomeView from '../HomeView.vue'
import HeroBand from '@/components/home/HeroBand.vue'
import RecentAlbumTiles from '@/components/home/RecentAlbumTiles.vue'
import TopSongsList from '@/components/home/TopSongsList.vue'
import SongShelf from '@/components/library/SongShelf.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Album, Song } from '@/types/library'

const vuetify = createVuetify({ components, directives })

/** created() fires a fistful of library requests this view's own hero
 * logic has nothing to do with — stubbed to empty results so mounting is
 * about the hero, not the shelves. */
function stubLibrary() {
  const library = useLibraryStore()
  vi.spyOn(library, 'fetchFrequentAlbums').mockResolvedValue([])
  vi.spyOn(library, 'fetchRecentlyPlayedAlbums').mockResolvedValue([])
  vi.spyOn(library, 'fetchRandomAlbums').mockResolvedValue([])
  vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
  vi.spyOn(library, 'fetchRediscoverSongs').mockResolvedValue([])
  vi.spyOn(library, 'fetchArtists').mockResolvedValue()
  vi.spyOn(library, 'client').mockReturnValue({
    getAlbumList2: vi.fn().mockResolvedValue([]),
    coverArtUrl: () => null,
  } as unknown as ReturnType<typeof library.client>)
  return library
}

/** `prepare` runs after stubLibrary() and before mounting, so a test can
 * replace a stub - created() has already asked by the time mount returns. */
async function mountHome(prepare?: (library: ReturnType<typeof useLibraryStore>) => void) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  const library = stubLibrary()
  prepare?.(library)
  const wrapper = mount(HomeView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: {
        AlbumShelf: true,
        SimilarArtistsShelf: true,
        RecentAlbumTiles: true,
        TopSongsList: true,
        CoverArt: true,
      },
      mocks: { $emitter: emitter },
    },
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

function album(id: string): Album {
  return { id, name: `Album ${id}`, artist: 'Someone' } as Album
}

/** A promise the test settles itself, for a request still on its way. */
function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('HomeView return visits', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the last list at once while the new one loads', async () => {
    const first = await mountHome((library) =>
      vi.mocked(library.fetchRecentlyPlayedAlbums).mockResolvedValue([album('a'), album('b')]),
    )
    await flushPromises()
    first.unmount()

    const refresh = pending<Album[]>()
    const second = await mountHome((library) =>
      vi.mocked(library.fetchRecentlyPlayedAlbums).mockReturnValue(refresh.promise),
    )
    const tiles = second.getComponent(RecentAlbumTiles)
    expect(tiles.props('loading')).toBe(false)
    expect(tiles.props('albums')).toEqual([album('b')])

    refresh.resolve([album('c'), album('d')])
    await flushPromises()
    expect(tiles.props('albums')).toEqual([album('d')])
  })

  it('keeps the last list when its refresh fails', async () => {
    const first = await mountHome((library) =>
      vi.mocked(library.fetchRecentlyPlayedAlbums).mockResolvedValue([album('a'), album('b')]),
    )
    await flushPromises()
    first.unmount()

    const second = await mountHome((library) =>
      vi.mocked(library.fetchRecentlyPlayedAlbums).mockRejectedValue(new Error('offline')),
    )
    await flushPromises()

    expect(second.getComponent(RecentAlbumTiles).props('albums')).toEqual([album('b')])
  })

  it('ends the placeholders when the first request fails, rather than keeping them up', async () => {
    const wrapper = await mountHome((library) =>
      vi.mocked(library.fetchRecentlyPlayedAlbums).mockRejectedValue(new Error('offline')),
    )
    await flushPromises()

    expect(wrapper.getComponent(RecentAlbumTiles).props('loading')).toBe(false)
  })
})

describe('HomeView recently played tiles', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('leave out the album the hero is already offering', async () => {
    const wrapper = await mountHome()
    useHomeStore().albums.recent = [album('a'), album('b')]
    await wrapper.vm.$nextTick()

    expect(wrapper.getComponent(RecentAlbumTiles).props('albums')).toEqual([album('b')])
  })

  it('include it while the hero shows something else', async () => {
    const wrapper = await mountHome()
    useHomeStore().albums.recent = [album('a'), album('b')]
    usePlaybackStore().setQueue([makeSong('playing')], 0)
    await wrapper.vm.$nextTick()

    expect(wrapper.getComponent(RecentAlbumTiles).props('albums')).toEqual([album('a'), album('b')])
  })
})

describe('HomeView top songs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('waits for the catalogue, then lists its most played songs', async () => {
    const catalogue = pending<void>()
    const wrapper = await mountHome((library) =>
      vi.mocked(library.fetchAllSongs).mockReturnValue(catalogue.promise),
    )
    const list = wrapper.getComponent(TopSongsList)
    expect(list.props('loading')).toBe(true)

    useLibraryStore().allSongs = [makeSong('once', { playCount: 1 })]
    catalogue.resolve()
    await flushPromises()

    expect(list.props('loading')).toBe(false)
    expect((list.props('songs') as Song[]).map((song) => song.id)).toEqual(['once'])
  })

  it('stops waiting when the catalogue fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = await mountHome((library) =>
      vi.mocked(library.fetchAllSongs).mockRejectedValue(new Error('offline')),
    )
    await flushPromises()

    expect(wrapper.getComponent(TopSongsList).props('loading')).toBe(false)
  })

  it('plays the songs the chart hands up from its play-all button', async () => {
    const wrapper = await mountHome()
    const shown = [makeSong('a'), makeSong('b')]
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()

    wrapper.getComponent(TopSongsList).vm.$emit('play-all', shown)

    expect(play).toHaveBeenCalledWith(shown, 0, false, true)
  })

  it('hands the chart its songs most played first', async () => {
    const wrapper = await mountHome()
    useLibraryStore().allSongs = [makeSong('b', { playCount: 2 }), makeSong('a', { playCount: 5 })]
    await wrapper.vm.$nextTick()

    const songs = wrapper.getComponent(TopSongsList).props('songs') as Song[]
    expect(songs.map((song) => song.id)).toEqual(['a', 'b'])
  })
})

describe('HomeView rediscover shelf', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('plays the songs it drew, in shelf order', async () => {
    const drawn = [makeSong('a'), makeSong('b')]
    const wrapper = await mountHome()
    vi.mocked(useLibraryStore().fetchRediscoverSongs).mockResolvedValue(drawn)
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    await (wrapper.vm as unknown as { loadRediscover: () => Promise<void> }).loadRediscover()
    await wrapper.vm.$nextTick()

    wrapper.findComponent(SongShelf).vm.$emit('play-all')

    expect(play).toHaveBeenCalledWith(drawn, 0, false, true)
  })

  it('draws again when shuffled', async () => {
    const wrapper = await mountHome()
    const fetch = vi.mocked(useLibraryStore().fetchRediscoverSongs)
    fetch.mockResolvedValue([makeSong('a')])
    await (wrapper.vm as unknown as { loadRediscover: () => Promise<void> }).loadRediscover()
    await wrapper.vm.$nextTick()
    const callsBefore = fetch.mock.calls.length

    await wrapper
      .findComponent(SongShelf)
      .find(`[title="${i18n.global.t('home.reroll')}"]`)
      .trigger('click')

    expect(fetch.mock.calls.length).toBe(callsBefore + 1)
  })
})

describe('HomeView hero', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('where the hero artwork leads', () => {
    it('points at Now Playing while a song is playing', async () => {
      const wrapper = await mountHome()
      usePlaybackStore().setQueue([makeSong('a')], 0)
      await wrapper.vm.$nextTick()

      expect(wrapper.getComponent(HeroBand).props('coverTo')).toBe('/now-playing')
    })

    it('points at Now Playing for a radio station too', async () => {
      const wrapper = await mountHome()
      usePlaybackStore().radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      await wrapper.vm.$nextTick()

      expect(wrapper.getComponent(HeroBand).props('coverTo')).toBe('/now-playing')
    })

    it('points nowhere for the "here is your most recent album" fallback', async () => {
      // Nothing is playing, so Now Playing would be empty — the artwork
      // keeps its older "click to play this" meaning there instead.
      const wrapper = await mountHome()
      await wrapper.vm.$nextTick()

      expect(usePlaybackStore().currentSong).toBeNull()
      expect(wrapper.getComponent(HeroBand).props('coverTo')).toBeNull()
    })
  })

  describe('hero artwork for a playing radio station', () => {
    it("shows the station's own favicon, not the last-played album's cover", async () => {
      // Reported live 2026-09-01: heroCoverId used to fall straight through
      // to recentAlbums[0] whenever currentSong was null, radio included —
      // so the hero kept showing whatever was playing before the station
      // started, and HeroBand.vue's own `imageUrl` prop (its fallback for
      // exactly this) was never even bound.
      const wrapper = await mountHome()
      usePlaybackStore().radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: 'https://chill.example',
      }
      await wrapper.vm.$nextTick()

      const hero = wrapper.getComponent(HeroBand)
      expect(hero.props('coverId')).toBeNull()
      expect(hero.props('radioFavicon')).toEqual({
        homePageUrl: 'https://chill.example',
        hint: '',
        minSize: 512,
      })
    })

    it('falls back to the Radio Browser favicon hint when there is no homepage', async () => {
      const wrapper = await mountHome()
      usePlaybackStore().radioStation = {
        id: '',
        name: 'Found FM',
        streamUrl: 'https://browsed.example/found',
        homePageUrl: null,
        favicon: 'https://cdn.example/found.png',
      }
      await wrapper.vm.$nextTick()

      expect(wrapper.getComponent(HeroBand).props('radioFavicon')).toMatchObject({
        hint: 'https://cdn.example/found.png',
      })
    })

    it('shows no image at all for a station with neither a homepage nor a favicon hint', async () => {
      const wrapper = await mountHome()
      usePlaybackStore().radioStation = {
        id: 'r1',
        name: 'Plain FM',
        streamUrl: 'https://stream.example/plain',
        homePageUrl: null,
      }
      await wrapper.vm.$nextTick()

      expect(wrapper.getComponent(HeroBand).props('radioFavicon')).toBeNull()
    })
  })

  describe('when a Song Radio can be started from the hero', () => {
    it('offers it while a song is playing', async () => {
      const wrapper = await mountHome()
      useAuthStore().capabilities.songRadio = true
      usePlaybackStore().setQueue([makeSong('a')], 0)
      await wrapper.vm.$nextTick()

      expect(wrapper.getComponent(HeroBand).props('canStartRadio')).toBe(true)
    })

    it('does not offer it for the "here is your most recent album" fallback', async () => {
      // That state has no single seed song to build a mix around — the
      // hero is an album there, not a track.
      const wrapper = await mountHome()
      useAuthStore().capabilities.songRadio = true
      await wrapper.vm.$nextTick()

      expect(usePlaybackStore().currentSong).toBeNull()
      expect(wrapper.getComponent(HeroBand).props('canStartRadio')).toBe(false)
    })

    it('does not offer it on a server that cannot build one', async () => {
      const wrapper = await mountHome()
      useAuthStore().capabilities.songRadio = false
      usePlaybackStore().setQueue([makeSong('a')], 0)
      await wrapper.vm.$nextTick()

      expect(wrapper.getComponent(HeroBand).props('canStartRadio')).toBe(false)
    })
  })

  describe('pressing play on the hero', () => {
    it('toggles the playing radio station instead of starting the last album', async () => {
      // Reported live 2026-09-01: onHeroPlay() only checked currentSong,
      // which is always null for radio (see routes/playback.py's
      // /play-url) — falling through to the "nothing playing" branch and
      // starting recentAlbums[0] instead of toggling the station.
      const wrapper = await mountHome()
      const playback = usePlaybackStore()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      await wrapper.vm.$nextTick()
      const toggleSpy = vi.spyOn(playback, 'togglePlay').mockResolvedValue()
      const playSongListSpy = vi.spyOn(playback, 'playSongList')

      await wrapper.getComponent(HeroBand).vm.$emit('play')

      expect(toggleSpy).toHaveBeenCalledOnce()
      expect(playSongListSpy).not.toHaveBeenCalled()
    })

    it('still starts the most recent album when nothing is playing at all', async () => {
      const wrapper = await mountHome()
      const playback = usePlaybackStore()
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchAlbum').mockResolvedValue({
        id: 'album-1',
        songs: [makeSong('a')],
      } as unknown as Awaited<ReturnType<typeof library.fetchAlbum>>)
      const playSongListSpy = vi.spyOn(playback, 'playSongList').mockResolvedValue()
      // fetchRecentlyPlayedAlbums is stubbed to [] by mountHome()'s
      // stubLibrary(), so seed the list directly the way the real fetch
      // result would have.
      useHomeStore().albums.recent = [{ id: 'album-1', name: 'Some Album' } as Album]
      await wrapper.vm.$nextTick()

      await wrapper.getComponent(HeroBand).vm.$emit('play')

      expect(playSongListSpy).toHaveBeenCalled()
    })
  })

  describe('starting it', () => {
    async function mountWithSong() {
      const wrapper = await mountHome()
      useAuthStore().capabilities.songRadio = true
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      await wrapper.vm.$nextTick()
      return { wrapper, playback }
    }

    it('builds the mix around the song the hero is actually showing', async () => {
      const { wrapper, playback } = await mountWithSong()
      const radioSpy = vi.spyOn(playback, 'startSongRadio').mockResolvedValue()

      await wrapper.getComponent(HeroBand).vm.$emit('song-radio')

      expect(radioSpy).toHaveBeenCalledWith(playback.currentSong)
    })

    it('shows the button as busy for the length of the request, then clears it', async () => {
      const { wrapper, playback } = await mountWithSong()
      let resolveRadio!: () => void
      vi.spyOn(playback, 'startSongRadio').mockReturnValue(
        new Promise<void>((resolve) => {
          resolveRadio = resolve
        }),
      )

      wrapper.getComponent(HeroBand).vm.$emit('song-radio')
      await wrapper.vm.$nextTick()
      expect(wrapper.getComponent(HeroBand).props('radioLoading')).toBe(true)

      resolveRadio()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await wrapper.vm.$nextTick()
      expect(wrapper.getComponent(HeroBand).props('radioLoading')).toBe(false)
    })

    it('reports a failure as a toast instead of an unhandled rejection', async () => {
      const { wrapper, playback } = await mountWithSong()
      vi.spyOn(playback, 'startSongRadio').mockRejectedValue(new Error('no similar songs'))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const toasts: unknown[] = []
      emitter.on('toast', (payload) => toasts.push(payload))

      await wrapper.getComponent(HeroBand).vm.$emit('song-radio')
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(toasts).toHaveLength(1)
      expect(toasts[0]).toMatchObject({ level: 'error', title: 'Song Radio' })
      // ...and the button is usable again rather than stuck spinning.
      expect(wrapper.getComponent(HeroBand).props('radioLoading')).toBe(false)
      emitter.all.clear()
    })
  })
})
