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
import { BACKDROP_URL, VISUALIZER_URL } from './api'
import { usePartyGuestStore } from './store'
import type {
  NowPlayingPanel,
  NowPlayingRadio,
  NowPlayingSong,
  NowPlayingSource,
} from '@/components/now-playing/source'

// The app's amber, as NowPlayingView falls back to it.
const FALLBACK_COLOR = '245, 169, 78'

// Same smoothing the app's cast bars use (its local analyser updates every
// frame; the guest's SSE feed roughly every 23ms).
const SMOOTHING_CAST = 0.3

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
export function useGuestNowPlayingSource(): {
  source: NowPlayingSource
  dispose: () => void
} {
  const store = usePartyGuestStore()

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

  function persist(name: Preference, value: boolean): void {
    try {
      localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ ...readPreferences(), [name]: value }))
    } catch {
      // Not remembered, still switched for now.
    }
  }

  const song: ComputedRef<NowPlayingSong | null> = computed(() =>
    toNowPlayingSong(store.snapshot?.current_song ?? null),
  )
  const radio: ComputedRef<NowPlayingRadio | null> = computed(() =>
    toNowPlayingRadio(store.snapshot?.radio ?? null),
  )
  const playing = computed(() => store.snapshot?.playing ?? false)
  const duration = computed(() => store.snapshot?.duration ?? 0)
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

  const lyrics = computed(() => store.currentLyrics)
  const visualizerAvailable = computed(() => Boolean(store.snapshot?.casting && song.value))
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
    const current = song.value
    if (current) {
      return [
        {
          key: current.id,
          kind: 'song',
          song: current,
          eyebrow: eyebrow.value,
          title: current.title,
          radioTag: null,
        },
      ]
    }
    const station = radio.value
    if (station) {
      return [
        {
          key: 'radio',
          kind: 'song',
          song: null,
          eyebrow: eyebrow.value,
          title: station.nowPlaying ?? station.name,
          radioTag: station.nowPlaying ? station.name : null,
        },
      ]
    }
    return []
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
    watch(
      () => ({ url: backdropSource.value, backdrop: store.snapshot?.backdrop }),
      ({ url, backdrop }) => {
        backdropColor.value = null
        if (url && backdrop) void loadColor(url, 'backdropColor')
      },
      { immediate: true },
    ),
    watch(
      () => song.value?.artist,
      () => {
        backdropIndex.value = null
      },
    ),
    watch(visualizerActive, (active) => (active ? openVisualizer() : closeVisualizer()), {
      immediate: true,
    }),
  ]

  const source: NowPlayingSource = reactive({
    song,
    radio,
    next: computed(() => null),
    playing,
    position: computed(() => store.position),
    duration,
    accentColor,
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
      index: computed(() => backdropIndex.value ?? store.snapshot?.backdrop_index ?? 0),
    }),
    lyrics: reactive({
      lines: computed(() => lyrics.value?.lines ?? []),
      synced: computed(() => lyrics.value?.synced ?? false),
      offset: computed(() => lyrics.value?.offset ?? 0),
      songKey: computed(() => lyrics.value?.song_id ?? null),
      loading: false,
      status: computed(() => {
        if (lyrics.value?.lines.length) return null
        return song.value ? i18n.global.t('lyrics.notFound') : null
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
      sample: () => resampleBands(bands.value),
      debug: null,
    }),
    capabilities: reactive({
      seek: false,
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
      lyricsOpen: computed({
        get: () => showLyrics.value,
        set: (open: boolean) => {
          showLyrics.value = open
          persist('showLyrics', open)
        },
      }),
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
    selectBackdrop: (index: number) => {
      backdropIndex.value = index
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
    },
  }
}
