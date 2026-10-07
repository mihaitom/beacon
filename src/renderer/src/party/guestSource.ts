import {
  computed,
  markRaw,
  reactive,
  ref,
  watch,
  type ComputedRef,
  type WatchStopHandle,
} from 'vue'
import GuestCover from './components/GuestCover.vue'
import { i18n } from '@/i18n'
import { extractDominantColor } from '@/services/colorExtractor'
import { resampleBands } from '@/services/visualizerBands'
import { visualizerBarColor } from '@/services/visualizerColor'
import type { GuestRadio, GuestSong } from './api'
import { BACKDROP_URL, LISTEN_VISUALIZER_URL, VISUALIZER_URL } from './api'
import { usePartyGuestStore } from './store'
import type {
  NowPlayingPanel,
  NowPlayingRadio,
  NowPlayingSong,
  NowPlayingSource,
} from '@/components/now-playing/source'

// The app's amber, as NowPlayingView falls back to it.
const FALLBACK_COLOR = '245, 169, 78'

// The app's cast smoothing (see NowPlayingView's SMOOTHING_CAST): the
// guest's feed is the same ~23ms backend frames.
const SMOOTHING_CAST = 0.3

// Listening along: frames older than this behind what is heard are of no
// more use, and the newest are kept only as far ahead as a guest's buffer
// can plausibly be.
const LISTEN_FRAMES_BEHIND_SECONDS = 1
const LISTEN_FRAMES_AHEAD_SECONDS = 30

type ListenFrame = [number, number[]]

/** The latest frame at or before `time`, dropping the ones before it. */
export function takeListenFrame(frames: ListenFrame[], time: number): number[] | null {
  let index = -1
  for (let i = 0; i < frames.length && frames[i]![0] <= time; i++) index = i
  if (index < 0) return null
  const bands = frames[index]![1]
  const stale = frames.findIndex((frame) => frame[0] >= time - LISTEN_FRAMES_BEHIND_SECONDS)
  frames.splice(0, Math.min(stale < 0 ? frames.length : stale, index))
  return bands
}

// How long before a track ends the corner starts announcing the next one,
// matching NowPlayingView's own NEXT_UP_SECONDS.
const NEXT_UP_SECONDS = 15

type Preference = 'showLyrics' | 'showVisualizer' | 'largeArtwork'
const PREFERENCE_KEY = 'beacon_party_view'

function readPreferences(): Partial<Record<Preference, boolean>> {
  try {
    return JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function readPreference(name: Preference, fallback: boolean): boolean {
  return readPreferences()[name] ?? fallback
}

function toNowPlayingSong(song: GuestSong | null): NowPlayingSong | null {
  if (!song) return null
  return {
    id: song.id,
    title: song.title,
    artist: song.artist ?? '',
    album: song.album ?? '',
    artistId: '',
    albumId: '',
    coverArtId: null,
    coverUrl: song.cover,
    wishedBy: song.wished_by ?? null,
  }
}

function toNowPlayingRadio(radio: GuestRadio | null): NowPlayingRadio | null {
  if (!radio) return null
  return {
    name: radio.name,
    nowPlaying: radio.now_playing,
    favicon: null,
    logoUrl: radio.logo,
    titleLog: [],
    titleLogComplete: true,
    searchQuery: '',
    searchPending: false,
    hasActiveSearch: false,
  }
}

/** The guest page's Now Playing source: the party snapshot through
 * `party/store.ts`, plus the guest's own view preferences, colour
 * extraction and visualizer feed. The app's presentation renders it exactly
 * as it renders the host's. */
export function useGuestNowPlayingSource(
  opts: { isCompact?: () => boolean; isOnScreen?: () => boolean } = {},
): {
  source: NowPlayingSource
  dispose: () => void
} {
  const store = usePartyGuestStore()
  // A phone has no room for a second card, as in the app.
  const isCompact = opts.isCompact ?? (() => false)
  // The source outlives the presentation (a phone shows one tab at a time),
  // so the visualizer feed has to ask whether anyone is looking.
  const isOnScreen = opts.isOnScreen ?? (() => true)

  const showLyrics = ref(readPreference('showLyrics', true))
  const showVisualizer = ref(readPreference('showVisualizer', true))
  const largeArtwork = ref(readPreference('largeArtwork', false))
  const coverColor = ref<string | null>(null)
  const backdropColor = ref<string | null>(null)
  // Which of the artist's backgrounds this guest stepped to; null is the
  // host's.
  const backdropIndex = ref<number | null>(null)
  const bands = ref<number[] | null>(null)
  let visualizerEvents: EventSource | null = null
  // Listening along: the stream's own frames, by stream time, shown once
  // this guest hears them. Plain, not reactive - sampled per animation frame.
  let listenFrames: ListenFrame[] = []
  let listenVisualizerEvents: EventSource | null = null

  function persist(name: Preference, value: boolean): void {
    try {
      localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ ...readPreferences(), [name]: value }))
    } catch {
      // Not remembered, still switched for now.
    }
  }

  // While listening along, the song this guest hears, a few seconds behind
  // the host (see party/store.ts's displaySong).
  const song: ComputedRef<NowPlayingSong | null> = computed(() =>
    toNowPlayingSong(store.displaySong),
  )
  const radio: ComputedRef<NowPlayingRadio | null> = computed(() =>
    toNowPlayingRadio(store.snapshot?.radio ?? null),
  )
  const playing = computed(() => store.displayPlaying)
  const duration = computed(() => store.displayDuration)
  const artworkLarge = computed(() => largeArtwork.value || !store.snapshot?.backdrop)
  const artworkHidden = computed(() => Boolean(store.snapshot?.backdrop) && !artworkLarge.value)

  const backdropSource = computed<string | null>(() => {
    const snap = store.snapshot
    if (snap?.backdrop && snap.current_song) {
      // Keyed by artist so a new artist's picture is a new URL; the host's
      // pick until this guest steps on.
      const artist = encodeURIComponent(snap.current_song.artist ?? '')
      return backdropIndex.value === null
        ? `${BACKDROP_URL}?artist=${artist}`
        : `${BACKDROP_URL}?artist=${artist}&index=${backdropIndex.value}`
    }
    // A station logo is no backdrop, as in the app.
    return snap?.current_song?.cover ?? null
  })

  const accentColor = computed(() => coverColor.value ?? FALLBACK_COLOR)
  const ambientStyle = computed<Record<string, string>>(() => {
    if (store.snapshot?.backdrop && !artworkLarge.value) return { background: 'none' }
    if (store.snapshot?.backdrop) return { background: 'rgba(18, 20, 28, 0.55)' }
    return {
      background: `radial-gradient(ellipse 65% 55% at 50% 32%, rgba(${accentColor.value}, 0.35), rgba(18, 20, 28, 0) 70%), rgba(18, 20, 28, 0.55)`,
    }
  })
  const glowColor = computed(
    () =>
      `radial-gradient(circle, rgba(${accentColor.value}, 0.55) 0%, rgba(${accentColor.value}, 0) 70%)`,
  )

  const next = computed<NowPlayingSong | null>(() => {
    if (radio.value) return null
    const upcoming = store.snapshot?.upcoming?.[0]
    return toNowPlayingSong(upcoming ?? null)
  })
  /** Whether the corner should announce the next song: a wide screen, the
   * artwork hidden (where the small cover + labels live), a next one, and
   * the current track within NEXT_UP_SECONDS of its end. */
  const nextUpActive = computed(() => {
    if (isCompact() || !artworkHidden.value || !next.value || !playing.value) return false
    const total = duration.value
    return total > 0 && total - store.position <= NEXT_UP_SECONDS
  })

  const lyrics = computed(() => store.currentLyrics)
  // While listening along the bars come from the stream itself, so they
  // exist during the host's local playback too.
  const visualizerAvailable = computed(() =>
    Boolean((store.listening || store.snapshot?.casting) && song.value),
  )
  const visualizerActive = computed(
    () => showVisualizer.value && visualizerAvailable.value && playing.value,
  )
  const visualizerColor = computed(() =>
    visualizerBarColor(store.snapshot?.backdrop ? backdropColor.value : null),
  )

  const eyebrow = computed(() => {
    if (radio.value) return i18n.global.t('home.radioEyebrow')
    return playing.value ? i18n.global.t('home.nowPlaying') : i18n.global.t('home.paused')
  })

  const panels = computed<NowPlayingPanel[]>(() => {
    const list: NowPlayingPanel[] = []
    const current = song.value
    if (current) {
      list.push({
        key: current.id,
        kind: 'song',
        song: current,
        eyebrow: eyebrow.value,
        title: current.title,
        radioTag: null,
      })
    } else if (radio.value) {
      const station = radio.value
      list.push({
        key: 'radio',
        kind: 'song',
        song: null,
        eyebrow: eyebrow.value,
        title: station.nowPlaying ?? station.name,
        radioTag: station.nowPlaying ? station.name : null,
      })
    }
    const upcoming = next.value
    if (nextUpActive.value && upcoming) {
      list.push({
        key: 'chevrons',
        kind: 'chevrons',
        song: null,
        eyebrow: '',
        title: '',
        radioTag: null,
      })
      list.push({
        key: upcoming.id,
        kind: 'song',
        song: upcoming,
        eyebrow: i18n.global.t('home.nextUp'),
        title: upcoming.title,
        radioTag: null,
      })
    }
    return list
  })

  function openVisualizer(): void {
    if (visualizerEvents) return
    visualizerEvents = new EventSource(VISUALIZER_URL, { withCredentials: true })
    visualizerEvents.onmessage = (event: MessageEvent<string>) => {
      bands.value = (JSON.parse(event.data) as { bands: number[] }).bands
    }
  }

  function closeVisualizer(): void {
    visualizerEvents?.close()
    visualizerEvents = null
    bands.value = null
  }

  function openListenVisualizer(): void {
    if (listenVisualizerEvents) return
    listenFrames = []
    listenVisualizerEvents = new EventSource(LISTEN_VISUALIZER_URL, { withCredentials: true })
    listenVisualizerEvents.onmessage = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { frames: ListenFrame[] }
      listenFrames.push(...data.frames)
      const heard = store.heardTimeNow()
      const newest = listenFrames.at(-1)?.[0] ?? 0
      const floor = (heard ?? newest) - LISTEN_FRAMES_AHEAD_SECONDS
      if ((listenFrames[0]?.[0] ?? 0) < floor) {
        listenFrames = listenFrames.filter((frame) => frame[0] >= floor)
      }
    }
  }

  function closeListenVisualizer(): void {
    listenVisualizerEvents?.close()
    listenVisualizerEvents = null
    listenFrames = []
  }

  function sampleBands(): number[] | null {
    if (!store.listening) return resampleBands(bands.value)
    const heard = store.heardTimeNow()
    if (heard === null) return null
    return resampleBands(takeListenFrame(listenFrames, heard))
  }

  async function loadColor(url: string, target: 'coverColor' | 'backdropColor'): Promise<void> {
    const rgb = await extractDominantColor(url)
    // The song or the picture may have changed while this loaded.
    const current = target === 'coverColor' ? song.value?.coverUrl : backdropSource.value
    if (url !== current) return
    const value = rgb ? rgb.join(', ') : null
    if (target === 'coverColor') coverColor.value = value
    else backdropColor.value = value
  }

  const stops: WatchStopHandle[] = [
    // The song's cover only: the app keeps its amber for a station, which
    // is also what keeps a dark logo readable against the glow.
    watch(
      () => song.value?.coverUrl,
      (url) => {
        coverColor.value = null
        if (url) void loadColor(url, 'coverColor')
      },
      { immediate: true },
    ),
    // immediate: the picture already there when the page opens needs its
    // colour as much as the next one.
    // On the URL alone: every snapshot is a new object, and resetting the
    // colour on each one flashed the bars and the app accent to amber.
    watch(
      backdropSource,
      (url) => {
        backdropColor.value = null
        if (url && store.snapshot?.backdrop) void loadColor(url, 'backdropColor')
      },
      { immediate: true },
    ),
    watch(
      () => song.value?.artist,
      () => {
        backdropIndex.value = null
      },
    ),
    watch(
      () => visualizerActive.value && isOnScreen() && !store.listening,
      (live) => (live ? openVisualizer() : closeVisualizer()),
      { immediate: true },
    ),
    watch(
      () => visualizerActive.value && isOnScreen() && store.listening,
      (live) => (live ? openListenVisualizer() : closeListenVisualizer()),
      { immediate: true },
    ),
  ]

  const source: NowPlayingSource = reactive({
    song,
    radio,
    position: computed(() => store.position),
    glowColor,
    ambientStyle,
    backdrop: reactive({
      source: backdropSource,
      isArtist: computed(() => Boolean(store.snapshot?.backdrop)),
      // The guest steps through the artist's backgrounds on its own; only
      // the count is known, which is what the toolbar's cycle button checks.
      backgrounds: computed(() => {
        const count = store.snapshot?.backdrop_count ?? 0
        return count > 0 ? Array.from<string>({ length: count }).fill('') : []
      }),
    }),
    lyrics: reactive({
      lines: computed(() => lyrics.value?.lines ?? []),
      synced: computed(() => lyrics.value?.synced ?? false),
      offset: computed(() => lyrics.value?.offset ?? 0),
      songKey: computed(() => lyrics.value?.song_id ?? null),
      loading: computed(() => store.lyricsLoading),
      status: computed(() => {
        if (lyrics.value?.lines.length || !song.value) return null
        return store.lyricsLoading
          ? i18n.global.t('lyrics.searching')
          : i18n.global.t('lyrics.notFound')
      }),
      sourceLabel: null,
      sourceUrl: null,
      credits: [],
    }),
    visualizer: reactive({
      available: visualizerAvailable,
      active: visualizerActive,
      color: visualizerColor,
      smoothing: SMOOTHING_CAST,
      sample: sampleBands,
      debug: null,
    }),
    capabilities: reactive({
      fullscreen: true,
      artistLinks: false,
      titleLog: false,
      autoplay: false,
      debug: false,
      lyricsTools: false,
    }),
    // Store-free, so the shared presentation never pulls the app's library
    // store (CoverArt's own imports) into the guest bundle.
    cover: markRaw(GuestCover),
    titleLogComponent: null,
    lyricsCandidateComponent: null,
    debugOverlayComponent: null,
    ui: reactive({
      lyricsOpen: computed(() => showLyrics.value),
      showVisualizer: computed(() => showVisualizer.value),
      artworkHidden,
    }),
    panels,
    searchTitles: () => {},
    loadOlderTitles: () => {},
    setLyricsOpen: (open: boolean) => {
      showLyrics.value = open
      persist('showLyrics', open)
    },
    toggleVisualizer: () => {
      showVisualizer.value = !showVisualizer.value
      persist('showVisualizer', showVisualizer.value)
    },
    toggleArtwork: () => {
      largeArtwork.value = !largeArtwork.value
      persist('largeArtwork', largeArtwork.value)
    },
    cycleBackground: () => {
      const count = store.snapshot?.backdrop_count ?? 0
      if (count < 2) return
      const current = backdropIndex.value ?? store.snapshot?.backdrop_index ?? 0
      backdropIndex.value = (current + 1) % count
    },
    seek: () => {},
    setLyricsOffset: () => {},
    resetLyricsOffset: () => {},
    loadLyricsCandidates: () => {},
    clearLyricsCandidates: () => {},
    toggleAutoplay: () => {},
    autoplayEnabled: () => false,
    addDebugTitle: () => {},
  }) as NowPlayingSource

  return {
    source,
    dispose: () => {
      stops.forEach((stop) => stop())
      closeVisualizer()
      closeListenVisualizer()
    },
  }
}
