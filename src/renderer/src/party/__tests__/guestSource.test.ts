import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { extractDominantColor } from '@/services/colorExtractor'
import { takeListenFrame, useGuestNowPlayingSource } from '../guestSource'
import { usePartyGuestStore } from '../store'
import {
  BACKDROP_URL,
  LISTEN_VISUALIZER_URL,
  VISUALIZER_URL,
  type GuestSnapshot,
  type GuestSong,
} from '../api'

// The real sampler needs a canvas jsdom does not implement.
vi.mock('@/services/colorExtractor', () => ({ extractDominantColor: vi.fn() }))

class FakeEventSource {
  static CLOSED = 2
  static instances: FakeEventSource[] = []
  readyState = 1
  constructor(public url = '') {
    FakeEventSource.instances.push(this)
  }
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  close() {
    this.readyState = 2
  }
}

const SONG: GuestSong = {
  id: 's1',
  title: 'Harbor Lights',
  artist: 'The Tide',
  album: 'Low Water',
  duration: 200,
  cover: '/party/api/cover?id=c1',
}

function snapshot(overrides: Partial<GuestSnapshot> = {}): GuestSnapshot {
  return {
    playing: true,
    position: 10,
    duration: 200,
    position_at: 1000,
    casting: false,
    backdrop: false,
    backdrop_index: 0,
    backdrop_count: 0,
    lyrics_key: null,
    current_song: null,
    radio: null,
    upcoming: [],
    listen: { enabled: false, epoch: null, timeline: [] },
    me: { name: 'Anna' },
    limits: { max_pending: 3, pending: 0 },
    skip: { enabled: true, votes: 0, needed: 2, mine: false },
    ...overrides,
  }
}

describe('guest Now Playing source', () => {
  let dispose: () => void

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('EventSource', FakeEventSource)
    FakeEventSource.instances = []
    vi.mocked(extractDominantColor).mockReset().mockResolvedValue(null)
    localStorage.clear()
  })

  afterEach(() => {
    dispose?.()
    vi.unstubAllGlobals()
  })

  it('maps the snapshot to the presentation shape, cover URL included', () => {
    usePartyGuestStore().applySnapshot(snapshot({ current_song: SONG }))
    const built = useGuestNowPlayingSource()
    dispose = built.dispose

    expect(built.source.song?.title).toBe('Harbor Lights')
    expect(built.source.song?.artist).toBe('The Tide')
    expect(built.source.song?.coverUrl).toBe('/party/api/cover?id=c1')
    expect(built.source.song?.coverArtId).toBeNull()
    expect(built.source.panels[0]?.title).toBe('Harbor Lights')
  })

  it('leaves every host-only capability off', () => {
    usePartyGuestStore().applySnapshot(snapshot({ current_song: SONG }))
    const built = useGuestNowPlayingSource()
    dispose = built.dispose

    expect(built.source.capabilities.artistLinks).toBe(false)
    expect(built.source.capabilities.titleLog).toBe(false)
    expect(built.source.capabilities.autoplay).toBe(false)
    expect(built.source.capabilities.debug).toBe(false)
    expect(built.source.capabilities.lyricsTools).toBe(false)
    // Fullscreen stays: it is the presentation's own, not the host's.
    expect(built.source.capabilities.fullscreen).toBe(true)
  })

  it('steps through the artist backgrounds on its own', () => {
    usePartyGuestStore().applySnapshot(
      snapshot({ backdrop: true, backdrop_count: 3, backdrop_index: 1, current_song: SONG }),
    )
    const built = useGuestNowPlayingSource()
    dispose = built.dispose

    expect(built.source.backdrop.backgrounds).toHaveLength(3)
    // The host's pick until this guest steps on.
    expect(built.source.backdrop.source).not.toContain('index=')
    built.source.cycleBackground()
    expect(built.source.backdrop.source).toContain('index=2')
    expect(built.source.ui.artworkHidden).toBe(true)
  })

  it('announces the next song near the end of a track, as the app does', () => {
    usePartyGuestStore().applySnapshot(
      snapshot({
        backdrop: true,
        duration: 200,
        position: 195,
        current_song: SONG,
        upcoming: [
          {
            id: 's2',
            title: 'Next One',
            artist: 'The Tide',
            album: null,
            duration: 180,
            cover: null,
          },
        ],
      }),
    )
    const built = useGuestNowPlayingSource()
    dispose = built.dispose

    expect(built.source.panels.map((p) => p.kind)).toEqual(['song', 'chevrons', 'song'])
    expect(built.source.panels[2]?.title).toBe('Next One')
  })

  it('takes the position from the party store', () => {
    const store = usePartyGuestStore()
    store.applySnapshot(snapshot({ position: 42, current_song: SONG }))
    store.now = store.snapshot!.position_at
    const built = useGuestNowPlayingSource()
    dispose = built.dispose

    expect(built.source.position).toBeCloseTo(42)
  })

  it("colours the bars with the cover without an artist background, the background's over it", async () => {
    vi.mocked(extractDominantColor).mockImplementation(async (url: string) =>
      url.startsWith(BACKDROP_URL) ? [200, 60, 60] : [60, 200, 60],
    )
    const store = usePartyGuestStore()
    store.applySnapshot(snapshot({ current_song: SONG }))
    const built = useGuestNowPlayingSource()
    dispose = built.dispose
    await flushPromises()
    const channels = () => built.source.visualizer.color.split(',').map(Number)

    const [r, g] = channels()
    expect(g).toBeGreaterThan(r!)

    store.applySnapshot(snapshot({ backdrop: true, backdrop_count: 1, current_song: SONG }))
    await flushPromises()
    const [r2, g2] = channels()
    expect(r2).toBeGreaterThan(g2!)
  })

  it('keeps the backdrop colour through snapshots that leave the picture alone', async () => {
    vi.mocked(extractDominantColor).mockResolvedValue([20, 140, 220])
    const store = usePartyGuestStore()
    const base = { backdrop: true, backdrop_count: 1, current_song: SONG }
    store.applySnapshot(snapshot(base))
    const built = useGuestNowPlayingSource()
    dispose = built.dispose
    await flushPromises()

    // A skip vote: a new snapshot, the same picture.
    store.applySnapshot(
      snapshot({ ...base, skip: { enabled: true, votes: 1, needed: 2, mine: false } }),
    )
    await nextTick()

    const backdropReads = vi
      .mocked(extractDominantColor)
      .mock.calls.filter(([url]) => String(url).startsWith(BACKDROP_URL))
    expect(backdropReads).toHaveLength(1)
  })

  it('keeps the visualizer feed closed while Now Playing is off screen', async () => {
    usePartyGuestStore().applySnapshot(snapshot({ casting: true, current_song: SONG }))
    const onScreen = ref(false)
    const built = useGuestNowPlayingSource({ isOnScreen: () => onScreen.value })
    dispose = built.dispose
    expect(FakeEventSource.instances).toHaveLength(0)

    onScreen.value = true
    await nextTick()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]!.readyState).toBe(1)

    onScreen.value = false
    await nextTick()
    expect(FakeEventSource.instances[0]!.readyState).toBe(FakeEventSource.CLOSED)
  })

  it("a listening guest's bars come from the stream, by what it hears", async () => {
    const store = usePartyGuestStore()
    // The host plays locally: no cast, so no bars for anyone else.
    store.applySnapshot(snapshot({ casting: false, current_song: SONG }))
    store.listenState = 'playing'
    const heard = vi.spyOn(store, 'heardTimeNow').mockReturnValue(10.05)
    const built = useGuestNowPlayingSource()
    dispose = built.dispose
    await nextTick()
    expect(built.source.visualizer.available).toBe(true)
    const feed = FakeEventSource.instances.find((e) => e.url === LISTEN_VISUALIZER_URL)!
    expect(FakeEventSource.instances.some((e) => e.url === VISUALIZER_URL)).toBe(false)
    const frames = [
      [10.0, [0.2]],
      [10.1, [0.9]],
    ]
    feed.onmessage?.({ data: JSON.stringify({ frames }) } as MessageEvent<string>)
    expect(built.source.visualizer.sample()?.[0]).toBe(0.2)
    heard.mockReturnValue(10.12)
    expect(built.source.visualizer.sample()?.[0]).toBe(0.9)

    store.listenState = 'off'
    await nextTick()
    expect(feed.readyState).toBe(FakeEventSource.CLOSED)
  })

  describe('Milkdrop', () => {
    it('is there on a wide screen while the bars have a feed, never on a phone', async () => {
      const store = usePartyGuestStore()
      store.applySnapshot(snapshot({ casting: false, current_song: SONG }))
      const compact = ref(false)
      const built = useGuestNowPlayingSource({ isCompact: () => compact.value })
      dispose = built.dispose
      expect(built.source.milkdrop.available).toBe(false)

      store.applySnapshot(snapshot({ casting: true, current_song: SONG }))
      expect(built.source.milkdrop.available).toBe(true)
      compact.value = true
      expect(built.source.milkdrop.available).toBe(false)
    })

    it('puts the song in the corner and the bars away while it plays, as the app does', async () => {
      usePartyGuestStore().applySnapshot(snapshot({ casting: true, current_song: SONG }))
      const built = useGuestNowPlayingSource()
      dispose = built.dispose
      expect(built.source.ui.artworkHidden).toBe(false)
      built.source.toggleMilkdrop()
      await nextTick()
      expect(built.source.ui.artworkHidden).toBe(true)
      expect(built.source.ambientStyle).toEqual({ background: 'none' })
      expect(built.source.visualizer.active).toBe(false)
    })

    it('stays away for a guest who asked for less motion', () => {
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
      usePartyGuestStore().applySnapshot(snapshot({ casting: true, current_song: SONG }))
      const built = useGuestNowPlayingSource()
      dispose = built.dispose
      expect(built.source.milkdrop.available).toBe(false)
    })

    it('is switched on by the guest, remembered, with a shipped preset of its own', async () => {
      const store = usePartyGuestStore()
      store.applySnapshot(snapshot({ casting: true, current_song: SONG }))
      const built = useGuestNowPlayingSource()
      dispose = built.dispose
      expect(built.source.milkdrop.active).toBe(false)

      built.source.toggleMilkdrop()
      await nextTick()
      expect(built.source.milkdrop.active).toBe(true)
      const first = built.source.milkdrop.preset
      expect(first).toMatch(/^builtin:/)
      built.source.nextMilkdropPreset()
      expect(built.source.milkdrop.preset).not.toBe(first)
      built.source.chooseMilkdropPreset('builtin:beacon-milky-way')
      expect(built.source.milkdrop.preset).toBe('builtin:beacon-milky-way')

      // A new song, a new preset - the app's own default.
      const second = built.source.milkdrop.preset
      store.applySnapshot(snapshot({ casting: true, current_song: { ...SONG, id: 's2' } }))
      await nextTick()
      expect(built.source.milkdrop.preset).not.toBe(second)

      built.dispose()
      const again = useGuestNowPlayingSource()
      dispose = again.dispose
      expect(again.source.milkdrop.active).toBe(true)
    })

    it('asks the cast feed for the samples, and plays them', async () => {
      usePartyGuestStore().applySnapshot(snapshot({ casting: true, current_song: SONG }))
      localStorage.setItem('beacon_party_view', JSON.stringify({ showVisualizer: false }))
      const built = useGuestNowPlayingSource()
      dispose = built.dispose
      expect(FakeEventSource.instances).toHaveLength(0)

      // Bars off, Milkdrop on: the feed is Milkdrop's alone.
      built.source.toggleMilkdrop()
      await nextTick()
      const feed = FakeEventSource.instances.at(-1)!
      expect(feed.url).toBe(`${VISUALIZER_URL}?waveform=1`)
      feed.onmessage?.({
        data: JSON.stringify({ bands: [0.5], waveform: 'gP8=' }),
      } as MessageEvent<string>)
      expect(Array.from(built.source.milkdrop.waveform()!)).toEqual([128, 255])

      built.source.toggleMilkdrop()
      await nextTick()
      expect(feed.readyState).toBe(FakeEventSource.CLOSED)
      expect(built.source.milkdrop.waveform()).toBeNull()
    })

    it('plays a listening guest the samples of what it hears', async () => {
      const store = usePartyGuestStore()
      store.applySnapshot(snapshot({ casting: false, current_song: SONG }))
      store.listenState = 'playing'
      const heard = vi.spyOn(store, 'heardTimeNow').mockReturnValue(10.05)
      const built = useGuestNowPlayingSource()
      dispose = built.dispose
      built.source.toggleMilkdrop()
      await nextTick()
      const feed = FakeEventSource.instances.at(-1)!
      expect(feed.url).toBe(`${LISTEN_VISUALIZER_URL}?waveform=1`)
      const frames = [
        [10.0, [0.2], 'AQ=='],
        [10.1, [0.9], 'Ag=='],
      ]
      feed.onmessage?.({ data: JSON.stringify({ frames }) } as MessageEvent<string>)
      expect(Array.from(built.source.milkdrop.waveform()!)).toEqual([1])
      heard.mockReturnValue(10.12)
      expect(Array.from(built.source.milkdrop.waveform()!)).toEqual([2])
    })

    it("takes the cover from the page's own cover route", async () => {
      usePartyGuestStore().applySnapshot(snapshot({ casting: true, current_song: SONG }))
      const built = useGuestNowPlayingSource()
      dispose = built.dispose
      const blob = new Blob(['x'])
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob })
      vi.stubGlobal('fetch', fetchMock)
      const cover = built.source.milkdrop.cover!
      expect(await cover.load(new AbortController().signal)).toBe(blob)
      expect(fetchMock.mock.calls[0]![0]).toBe(SONG.cover)
      fetchMock.mockResolvedValue({ ok: false })
      expect(await cover.load(new AbortController().signal)).toBeNull()
    })
  })

  it('drops frames nobody can hear any more, never the one shown', () => {
    const frames: [number, number[]][] = [
      [1, [1]],
      [2, [2]],
      [5, [5]],
      [6, [6]],
    ]
    expect(takeListenFrame(frames, 0.5)).toBeNull()
    expect(takeListenFrame(frames, 5.5)).toEqual([5, [5]])
    expect(frames.map((frame) => frame[0])).toEqual([5, 6])
  })

  it('says it is looking for lyrics while they are on their way', () => {
    const store = usePartyGuestStore()
    store.applySnapshot(snapshot({ current_song: SONG }))
    const built = useGuestNowPlayingSource()
    dispose = built.dispose

    store.lyricsLoading = true
    expect(built.source.lyrics.status).toBe(i18n.global.t('lyrics.searching'))

    store.lyricsLoading = false
    expect(built.source.lyrics.status).toBe(i18n.global.t('lyrics.notFound'))
  })
})
