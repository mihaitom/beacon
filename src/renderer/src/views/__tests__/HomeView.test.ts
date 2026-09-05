// Covers the hero band's own decisions, which HeroBand.vue deliberately
// doesn't make: it renders a Song Radio button when told to, while *when*
// to tell it, and what happens on the click, live here.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import HomeView from '../HomeView.vue'
import HeroBand from '@/components/home/HeroBand.vue'
import SongTable from '@/components/library/SongTable.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Song } from '@/types/library'

const vuetify = createVuetify({ components, directives })

/** created() fires a fistful of library requests this view's own hero
 * logic has nothing to do with — stubbed to empty results so mounting is
 * about the hero, not the shelves. */
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
  return library
}

async function mountHome() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  stubLibrary()
  const wrapper = mount(HomeView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { AlbumShelf: true, SimilarArtistsShelf: true, SongTable: true, CoverArt: true },
      mocks: { $emitter: emitter },
    },
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('HomeView top songs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** The most-played list is a chart, not a running order: clicking one of
   * its rows plays that song rather than queueing the other nine behind
   * it. Starting the whole list is what the play button next to the
   * heading is for. The behaviour itself is SongTable's and has its own
   * test (SongTable.play.test.ts); this pins that Home asks for it. */
  it('hands the top-songs table the one-song rule rather than the default', async () => {
    const wrapper = await mountHome()
    ;(wrapper.vm as unknown as { topSongs: Song[] }).topSongs = [makeSong('a'), makeSong('b')]
    await wrapper.vm.$nextTick()

    const table = wrapper.findComponent(SongTable)
    expect(table.exists()).toBe(true)
    expect(table.props('queueWholeList')).toBe(false)
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
      // stubLibrary(), so seed recentAlbums directly the way the real
      // fetch result would have.
      ;(wrapper.vm as unknown as { recentAlbums: unknown[] }).recentAlbums = [
        { id: 'album-1', name: 'Some Album' },
      ]
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
