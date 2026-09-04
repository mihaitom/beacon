import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useDrawersStore } from '@/stores/drawers'
import { useConnectStore } from '@/stores/connect'
import { useLyricsStore } from '@/stores/lyrics'
import { useAuthStore } from '@/stores/auth'
import { useAutoplayStore } from '@/stores/autoplay'
import NowPlayingView from '../NowPlayingView.vue'
import { getAudioEngine } from '@/services/audioEngine'
import { makeSong } from '@/stores/__tests__/fixtures'

// The view asks the engine whether a local analyser exists at all — jsdom
// has no AudioContext, so a real one would always answer no and every
// visualizer case below would be testing the wrong branch.
vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))

/** Stands in for a build where the graph came up (desktop, desktop
 * browser); `false` is a phone, where it deliberately never does. */
function withAnalyser(available: boolean): void {
  vi.mocked(getAudioEngine).mockReturnValue({
    hasAnalyser: available,
  } as unknown as ReturnType<typeof getAudioEngine>)
}

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
    withAnalyser(true)
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
      useDrawersStore().lyricsDrawerOpen = true
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

    it("shows the station's own now-playing tag as the title, station name in place of the artist link", async () => {
      const { wrapper } = await mountView()
      const playback = usePlaybackStore()
      playback.radioStation = {
        id: '',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      playback.radioNowPlaying = 'Artist - Track'
      await wrapper.vm.$nextTick()

      expect(wrapper.get('.now-playing__title').text()).toBe('Artist - Track')
      expect(wrapper.get('.now-playing__radio-tag').text()).toBe('Chill FM')
    })
  })

  describe('visualizer availability', () => {
    it('is available during local (non-casting) playback', async () => {
      const { wrapper } = await mountWithSongFor()
      expect((wrapper.vm as unknown as { visualizerAvailable: boolean }).visualizerAvailable).toBe(
        true,
      )
    })

    it('is unavailable locally on a device with no audio graph to read', async () => {
      // A phone plays without one so that playback survives the screen
      // locking (see webAudioAllowed() in services/audioEngine.ts), which
      // leaves nothing to visualize.
      withAnalyser(false)

      const { wrapper } = await mountWithSongFor()

      expect((wrapper.vm as unknown as { visualizerAvailable: boolean }).visualizerAvailable).toBe(
        false,
      )
    })

    it('is available while casting even with no local graph, its data coming from the backend', async () => {
      withAnalyser(false)
      const { wrapper } = await mountWithSongFor()
      const connect = useConnectStore()
      connect.status = statusWithTargets([{ name: 'Living Room', type: 'sonos' }])
      await wrapper.vm.$nextTick()

      expect((wrapper.vm as unknown as { visualizerAvailable: boolean }).visualizerAvailable).toBe(
        true,
      )
    })

    it('is available casting to AirPlay only', async () => {
      // AirPlay used to be excluded here (see connect/core/audio_analysis.py's
      // module docstring for why that no longer holds) - the backend analyzes
      // it like any other cast target now, so the frontend no longer needs its
      // own AirPlay-specific check on top of should_analyze().
      const { wrapper } = await mountWithSongFor()
      const connect = useConnectStore()
      connect.status = statusWithTargets([{ name: 'Living Room', type: 'airplay' }])
      await wrapper.vm.$nextTick()

      expect((wrapper.vm as unknown as { visualizerAvailable: boolean }).visualizerAvailable).toBe(
        true,
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

    it('is unavailable casting radio to Sonos while RADIO_VISUALIZER_ENABLED is off', async () => {
      // Sonos would otherwise qualify: a cast over the "real" radio URI
      // scheme (x-rincon-mp3radio://) reports position 0.00s for a
      // continuous stream, no device feedback to calibrate against — but
      // delivery/sonos.py deliberately dispatches radio over plain http://
      // instead (see its own comment), which makes Sonos treat it like a
      // regular file and report a real, live position. Confirmed live
      // 2026-09-02 (device=6.00s at wall=8.08s) — see connect/core/
      // radio_position.py's module docstring. But connect.ts's own
      // RADIO_VISUALIZER_ENABLED flag (off since 2026-09-04, after days
      // spent unable to keep this synced to the audio a cast device
      // actually plays) makes isRadioPositionCapable() answer false for
      // every type regardless, so this stays unavailable until it flips
      // back on.
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

    it('is unavailable casting radio to AirPlay (no position to poll at all)', async () => {
      const { wrapper } = await mountView()
      const playback = usePlaybackStore()
      const connect = useConnectStore()
      playback.radioStation = {
        id: '',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      connect.status = statusWithTargets([{ name: 'Living Room', type: 'airplay' }])
      await wrapper.vm.$nextTick()

      expect((wrapper.vm as unknown as { visualizerAvailable: boolean }).visualizerAvailable).toBe(
        false,
      )
    })

    it('is unavailable casting radio to Chromecast while RADIO_VISUALIZER_ENABLED is off', async () => {
      // Chromecast would otherwise qualify — measured live 2026-09-02
      // (connect/scripts/icy_sync_probe.py against a real device): its own
      // reported position is real and stable once past its own startup
      // buffer, see connect/core/radio_position.py — but see the Sonos test
      // above for why this is false regardless right now.
      const { wrapper } = await mountView()
      const playback = usePlaybackStore()
      const connect = useConnectStore()
      playback.radioStation = {
        id: '',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      connect.status = statusWithTargets([{ name: 'Living Room', type: 'chromecast' }])
      await wrapper.vm.$nextTick()

      expect((wrapper.vm as unknown as { visualizerAvailable: boolean }).visualizerAvailable).toBe(
        false,
      )
    })

    it('is unavailable casting radio to DLNA while RADIO_VISUALIZER_ENABLED is off', async () => {
      const { wrapper } = await mountView()
      const playback = usePlaybackStore()
      const connect = useConnectStore()
      playback.radioStation = {
        id: '',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      connect.status = statusWithTargets([{ name: 'TV', type: 'dlna' }])
      await wrapper.vm.$nextTick()

      expect((wrapper.vm as unknown as { visualizerAvailable: boolean }).visualizerAvailable).toBe(
        false,
      )
    })

    it('stays unavailable casting radio even when one of several targets would be position-capable', async () => {
      // Multi-target casting can mix protocols (e.g. AirPlay and a
      // Chromecast at once) — the backend picks the first position-capable
      // delivery as its reference (core/state.py's
      // first_radio_position_delivery()), which would normally be enough to
      // make the visualizer worth showing, but RADIO_VISUALIZER_ENABLED
      // being off overrides that for every type, Chromecast included.
      const { wrapper } = await mountView()
      const playback = usePlaybackStore()
      const connect = useConnectStore()
      playback.radioStation = {
        id: '',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      connect.status = statusWithTargets([
        { name: 'Living Room', type: 'airplay' },
        { name: 'Kitchen', type: 'chromecast' },
      ])
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
        stream_info: {
          label: 'mp3-192k (fallback)',
          content_type: 'audio/mpeg',
          transcoding: true,
          source_codec: null,
          source_sample_rate: null,
          source_bit_depth: null,
          source_bitrate_kbps: null,
          target_sample_rate: null,
          target_bit_depth: null,
          target_bitrate_kbps: null,
          transcode_reason: null,
          active_connections: 0,
          loop_lag: 0,
        },
        queue: [],
        current_song_index: -1,
        original_queue: [],
        shuffle: false,
        repeat_mode: 'off' as const,
        autoplay_enabled: false,
        elapsed: 0,
        ended: false,
        paused: false,
        radio: null,
        radio_buffering: false,
        streaming: false,
        targets: targets as never,
        total_songs: 0,
        displaced: false,
        interrupted: false,
        delivery_error: null,
      }
    }
  })

  describe('toolbar buttons', () => {
    // One rule across the whole app (see the toolbar's own comment):
    // color="primary" — amber — means the thing behind the button is on.
    // These four each used to state it differently, or not at all.
    async function mountToolbar(props: Record<string, unknown> = {}) {
      const mounted = await mountView(props)
      usePlaybackStore().setQueue([makeSong('a')], 0)
      // Autoplay's button is behind the same capability gate PlayerBar's is.
      useAuthStore().capabilities.songRadio = true
      await mounted.wrapper.vm.$nextTick()
      return mounted
    }

    /** The rendered button carrying `icon`, by its mdi class. */
    function button(wrapper: VueWrapper, icon: string) {
      return wrapper.get(`.now-playing__toolbar .${icon}`).element.closest('button')!
    }

    function isAmber(wrapper: VueWrapper, icon: string): boolean {
      return button(wrapper, icon).classList.contains('text-primary')
    }

    it('colors the lyrics button while lyrics are showing', async () => {
      // Only rendered where it's the only way to reach lyrics at all.
      const { wrapper } = await mountToolbar({ compact: true })
      expect(isAmber(wrapper, 'mdi-script-text-outline')).toBe(false)

      useDrawersStore().lyricsDrawerOpen = true
      await wrapper.vm.$nextTick()

      expect(isAmber(wrapper, 'mdi-script-text-outline')).toBe(true)
    })

    it('colors the autoplay button while autoplay is on', async () => {
      const { wrapper } = await mountToolbar({ compact: true })
      expect(isAmber(wrapper, 'mdi-infinity')).toBe(false)

      useAutoplayStore().enabled = true
      await wrapper.vm.$nextTick()

      expect(isAmber(wrapper, 'mdi-infinity')).toBe(true)
    })

    it.each([
      ['desktop', {}],
      // The mobile web UI renders this same toolbar — MobileNowPlayingView.vue
      // is a thin wrapper around <now-playing-view compact />.
      ['mobile (compact)', { compact: true }],
    ])('colors the visualizer button while it is showing, on %s', async (_name, props) => {
      const { wrapper } = await mountToolbar(props)
      const vm = wrapper.vm as unknown as { showVisualizer: boolean }
      vm.showVisualizer = false
      await wrapper.vm.$nextTick()
      expect(isAmber(wrapper, 'mdi-equalizer')).toBe(false)

      vm.showVisualizer = true
      await wrapper.vm.$nextTick()

      expect(isAmber(wrapper, 'mdi-equalizer')).toBe(true)
      // The outline/filled icon swap it used to rely on instead is gone —
      // the state is the color's job now, same as every other toggle.
      expect(wrapper.find('.now-playing__toolbar .mdi-equalizer-outline').exists()).toBe(false)
    })

    it('colors the lyrics button on mobile too, where it is the only way to reach lyrics', async () => {
      const { wrapper } = await mountToolbar({ compact: true })

      useDrawersStore().lyricsDrawerOpen = true
      await wrapper.vm.$nextTick()

      expect(isAmber(wrapper, 'mdi-script-text-outline')).toBe(true)
    })

    it('colors the fullscreen button while fullscreen, and still swaps its icon', async () => {
      const { wrapper } = await mountToolbar()
      const vm = wrapper.vm as unknown as { isFullscreen: boolean }
      expect(isAmber(wrapper, 'mdi-fullscreen')).toBe(false)

      vm.isFullscreen = true
      await wrapper.vm.$nextTick()

      // The icon swap stays: unlike the others, it describes what clicking
      // does (leave fullscreen), not just the state the color carries.
      expect(isAmber(wrapper, 'mdi-fullscreen-exit')).toBe(true)
    })
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
