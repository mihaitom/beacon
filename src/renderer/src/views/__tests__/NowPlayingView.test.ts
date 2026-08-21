import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useConnectStore } from '@/stores/connect'
import { useLyricsStore } from '@/stores/lyrics'
import NowPlayingView from '../NowPlayingView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/artists/:id', component: { template: '<div />' } },
      { path: '/albums/:id', component: { template: '<div />' } },
    ],
  })
}

async function mountView(props: Record<string, unknown> = {}) {
  const router = makeRouter()
  await router.push('/')
  await router.isReady()
  const host = mount(
    {
      components: { NowPlayingView },
      props: ['viewProps'],
      template: '<v-app><now-playing-view v-bind="viewProps" /></v-app>',
    },
    {
      props: { viewProps: props },
      global: {
        plugins: [vuetify, i18n, router],
        stubs: {
          // Each of these pulls in canvas/image-loading/CORS-fetch
          // machinery this view doesn't itself own — CoverArt.vue's own
          // <img>, LyricsPanel.vue's fetch-backed content, AudioVisualizer's
          // Web Audio analyser. Stubbing keeps these tests about
          // NowPlayingView's own conditionals, not their internals.
          CoverArt: true,
          LyricsPanel: true,
          AudioVisualizer: true,
        },
      },
    },
  )
  const wrapper = host.findComponent(NowPlayingView)
  return { wrapper, host, router }
}

describe('NowPlayingView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // extractDominantColor()/hasTransparency() only ever run when a song
    // has coverArtId or a radio station has a homePageUrl — every fixture
    // below leaves both unset, so neither the canvas-based color sampler
    // nor a real fetch() ever fires.
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('nothing playing', () => {
    it('shows the placeholder instead of artwork/info', async () => {
      const { wrapper } = await mountView()

      expect(wrapper.text()).toContain('Nothing is playing right now.')
      expect(wrapper.find('.now-playing__title').exists()).toBe(false)
    })
  })

  describe('a song is playing', () => {
    async function mountWithSong(overrides: Parameters<typeof makeSong>[1] = {}) {
      const mounted = await mountView()
      const playback = usePlaybackStore()
      playback.setQueue(
        [makeSong('a', { title: 'Track A', artist: 'Artist A', album: 'Album A', ...overrides })],
        0,
      )
      await mounted.wrapper.vm.$nextTick()
      return { ...mounted, playback }
    }

    it('renders title, artist link and album link', async () => {
      const { wrapper } = await mountWithSong()

      expect(wrapper.get('.now-playing__title').text()).toBe('Track A')
      const artistLink = wrapper.get('.now-playing__artist-link')
      expect(artistLink.text()).toBe('Artist A')
      expect(artistLink.attributes('href')).toBe('/artists/artist-1')
      const albumLink = wrapper.get('.now-playing__album-link')
      expect(albumLink.text()).toBe('Album A')
      expect(albumLink.attributes('href')).toBe('/albums/album-1')
    })

    it('shows the "now playing" eyebrow while playing and "paused" while not', async () => {
      const { wrapper, playback } = await mountWithSong()
      playback.isPlaying = true
      await wrapper.vm.$nextTick()
      expect(wrapper.get('.eyebrow-label').text()).toBe('Now playing')

      playback.isPlaying = false
      await wrapper.vm.$nextTick()
      expect(wrapper.get('.eyebrow-label').text()).toBe('Pause')
    })

    it('preloads lyrics for the current song and again for the next one', async () => {
      const { playback } = await mountWithSong()
      const lyrics = useLyricsStore()
      const ensureLoadedSpy = vi.spyOn(lyrics, 'ensureLoaded').mockResolvedValue()

      const b = makeSong('b', { title: 'Track B' })
      playback.setQueue([playback.currentSong!, b], 1)
      await flushPromises()

      expect(ensureLoadedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
    })

    it('turns showLyrics off again when switching away to no song', async () => {
      const { wrapper, playback } = await mountWithSong()
      usePlaybackStore().lyricsDrawerOpen = true
      await wrapper.vm.$nextTick()
      expect((wrapper.vm as unknown as { showLyrics: boolean }).showLyrics).toBe(true)

      playback.setQueue([], -1)
      await wrapper.vm.$nextTick()

      expect((wrapper.vm as unknown as { showLyrics: boolean }).showLyrics).toBe(false)
    })
  })

  describe('radio', () => {
    it('shows the station name and the radio eyebrow, without artist/album links', async () => {
      const { wrapper } = await mountView()
      const playback = usePlaybackStore()
      playback.radioStation = {
        id: '',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      await wrapper.vm.$nextTick()

      expect(wrapper.get('.now-playing__title').text()).toBe('Chill FM')
      expect(wrapper.get('.eyebrow-label').text()).toBe('Radio')
      expect(wrapper.find('.now-playing__artist-link').exists()).toBe(false)
      expect(wrapper.find('.now-playing__album-link').exists()).toBe(false)
    })
  })

  describe('visualizer availability', () => {
    it('is available during local (non-casting) playback', async () => {
      const { wrapper } = await mountWithSongFor()
      expect((wrapper.vm as unknown as { visualizerAvailable: boolean }).visualizerAvailable).toBe(
        true,
      )
    })

    it('is unavailable casting to AirPlay only', async () => {
      const { wrapper } = await mountWithSongFor()
      const connect = useConnectStore()
      connect.status = statusWithTargets([{ name: 'Living Room', type: 'airplay' }])
      await wrapper.vm.$nextTick()

      expect((wrapper.vm as unknown as { visualizerAvailable: boolean }).visualizerAvailable).toBe(
        false,
      )
    })

    it('is available casting to a non-AirPlay target', async () => {
      const { wrapper } = await mountWithSongFor()
      const connect = useConnectStore()
      connect.status = statusWithTargets([{ name: 'Kitchen', type: 'sonos' }])
      await wrapper.vm.$nextTick()

      expect((wrapper.vm as unknown as { visualizerAvailable: boolean }).visualizerAvailable).toBe(
        true,
      )
    })

    it('is unavailable casting radio (no current song at all)', async () => {
      const { wrapper } = await mountView()
      const playback = usePlaybackStore()
      const connect = useConnectStore()
      playback.radioStation = {
        id: '',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      connect.status = statusWithTargets([{ name: 'Kitchen', type: 'sonos' }])
      await wrapper.vm.$nextTick()

      expect((wrapper.vm as unknown as { visualizerAvailable: boolean }).visualizerAvailable).toBe(
        false,
      )
    })

    async function mountWithSongFor() {
      const mounted = await mountView()
      usePlaybackStore().setQueue([makeSong('a', { title: 'Track A' })], 0)
      await mounted.wrapper.vm.$nextTick()
      return mounted
    }

    function statusWithTargets(targets: { name: string; type: string }[]) {
      return {
        current_song: null,
        queue: [],
        current_song_index: -1,
        original_queue: [],
        shuffle: false,
        repeat_mode: 'off' as const,
        elapsed: 0,
        ended: false,
        paused: false,
        radio: null,
        streaming: false,
        targets: targets as never,
        total_songs: 0,
        displaced: false,
      }
    }
  })

  describe('visualizer toggle', () => {
    it('persists the preference to localStorage', async () => {
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
      const { wrapper } = await mountView()
      const vm = wrapper.vm as unknown as { showVisualizer: boolean }
      expect(vm.showVisualizer).toBe(true) // default when never toggled before

      vm.showVisualizer = false
      await wrapper.vm.$nextTick()

      expect(setItemSpy).toHaveBeenCalledWith('beacon.showVisualizer', 'false')
    })
  })

  describe('fullscreen toggle', () => {
    it('requests fullscreen on the root element and tracks state via fullscreenchange', async () => {
      const { wrapper } = await mountView()
      const rootEl = wrapper.element as HTMLElement
      const requestFullscreen = vi.fn().mockImplementation(function (this: HTMLElement) {
        Object.defineProperty(document, 'fullscreenElement', {
          value: this,
          configurable: true,
        })
        document.dispatchEvent(new Event('fullscreenchange'))
        return Promise.resolve()
      })
      rootEl.requestFullscreen = requestFullscreen as unknown as typeof rootEl.requestFullscreen

      const vm = wrapper.vm as unknown as {
        toggleFullscreen(): Promise<void>
        isFullscreen: boolean
      }
      await vm.toggleFullscreen()

      expect(requestFullscreen).toHaveBeenCalledOnce()
      expect(vm.isFullscreen).toBe(true)

      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
    })
  })

  describe('compact prop', () => {
    it('applies the compact modifier class', async () => {
      const { wrapper } = await mountView({ compact: true })

      expect(wrapper.classes()).toContain('now-playing--compact')
    })
  })
})
