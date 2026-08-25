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
import { makeSong } from '@/stores/__tests__/fixtures'

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

describe('HomeView hero', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
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
