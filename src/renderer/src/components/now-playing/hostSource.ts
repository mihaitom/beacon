import { computed, markRaw, reactive } from 'vue'
import CoverArt from '@/components/library/CoverArt.vue'
import RadioTitleLog from '@/components/radio/RadioTitleLog.vue'
import LyricsCandidateList from '@/components/lyrics/LyricsCandidateList.vue'
import VisualizerDebugOverlay from '@/components/player/VisualizerDebugOverlay.vue'
import type { Song, RadioStation } from '@/types/library'
import type { RadioFaviconRequest } from '@/services/connect/radio'
import type { RadioTitleEntry } from '@/services/connect/radioMetadata'
import type { VisualizerFrame } from '@/services/connect/types'
import { FILE_SOURCE, useLyricsStore } from '@/stores/lyrics'
import { lyricsPageUrl } from '@/services/lyrics/providerUrl'
import { i18n } from '@/i18n'
import type { NowPlayingPanel, NowPlayingRadio, NowPlayingSong, NowPlayingSource } from './source'

/** The slice of NowPlayingView the host source is built from. The view keeps
 * owning all of it (the stores, the Fanart.tv lookups, the colour
 * extraction); this only re-shapes it for the presentation, so no stage,
 * toolbar or lyrics panel has to import a store. */
export interface HostNowPlayingApi {
  currentSong: Song | null
  radioStation: RadioStation | null
  nextSong: Song | null
  radioFavicon: RadioFaviconRequest | null
  isPlaying: boolean
  localPosition: number
  duration: number
  colorTriplet: string
  glowColor: string
  ambientStyle: Record<string, string>
  backdropSource: string | null
  backdropIsArtist: boolean
  artistBackgrounds: string[]
  artistBackground: string | null
  visualizerAvailable: boolean
  visualizerActive: boolean
  visualizerColor: string
  visualizerSmoothing: number
  visualizerSample: () => number[] | null
  visualizerDebug: VisualizerFrame['debug'] | null
  showLyrics: boolean
  showVisualizer: boolean
  artworkHidden: boolean
  cornerPanels: NowPlayingPanel[]
  titleLogEntries: RadioTitleEntry[]
  radioNowPlaying: string | null
  radioTitleLogComplete: boolean
  radioSearchQuery: string
  radioSearchPending: boolean
  radioHasActiveSearch: boolean
  autoplayEnabled: boolean
  debugEnabled: boolean

  setLyricsOpen(open: boolean): void
  toggleVisualizer(): void
  toggleArtwork(): void
  cycleArtistBackground(): void
  searchTitleLog(query: string): void
  loadOlderTitles(): void
  setLyricsOffset(offset: number): void
  seek(seconds: number): void
  loadLyricsCandidates(): void
  clearLyricsCandidates(): void
  toggleAutoplay(): void
  addDebugTitle(): void
}

/** Maps the app's Song to the presentation shape. Exported so NowPlayingView
 * can build its corner panels with the same shape the source carries. */
export function toNowPlayingSong(song: Song | null): NowPlayingSong | null {
  if (!song) return null
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    artistId: song.artistId,
    albumId: song.albumId,
    coverArtId: song.coverArtId,
    coverUrl: null,
    wishedBy: null,
  }
}

/** What to say when there are no lyric lines to show, or null when there
 * are. Exported so tests can build a source without the whole view. */
export function lyricsStatus(currentSongId: string | null): string | null {
  const lyrics = useLyricsStore()
  if (lyrics.loading) return i18n.global.t('lyrics.searching')
  if (!lyrics.error && lyrics.lines.length > 0) return null
  if (currentSongId !== null && lyrics.songId !== currentSongId) {
    return i18n.global.t('lyrics.searching')
  }
  return i18n.global.t('lyrics.notFound')
}

export function lyricsSourceLabel(): string | null {
  const source = useLyricsStore().source
  if (!source) return null
  return source === FILE_SOURCE ? i18n.global.t('lyrics.sourceFile') : source
}

export function lyricsSourceUrl(): string | null {
  const lyrics = useLyricsStore()
  return lyricsPageUrl(lyrics.source, lyrics.remoteId)
}

function hostRadio(api: HostNowPlayingApi): NowPlayingRadio | null {
  const station = api.radioStation
  if (!station) return null
  return {
    name: station.name,
    nowPlaying: api.radioNowPlaying,
    favicon: api.radioFavicon,
    logoUrl: null,
    titleLog: api.titleLogEntries,
    titleLogComplete: api.radioTitleLogComplete,
    searchQuery: api.radioSearchQuery,
    searchPending: api.radioSearchPending,
    hasActiveSearch: api.radioHasActiveSearch,
  }
}

/** Builds the app's Now Playing source around a live NowPlayingView. Every
 * field is a computed over the view's own state, so the injected object is
 * reactive without the view having to copy anything. */
export function hostNowPlayingSource(api: HostNowPlayingApi): NowPlayingSource {
  return reactive({
    song: computed(() => toNowPlayingSong(api.currentSong)),
    radio: computed(() => hostRadio(api)),
    next: computed(() => toNowPlayingSong(api.nextSong)),
    playing: computed(() => api.isPlaying),
    position: computed(() => api.localPosition),
    duration: computed(() => api.duration),
    accentColor: computed(() => api.colorTriplet),
    glowColor: computed(() => api.glowColor),
    ambientStyle: computed(() => api.ambientStyle),
    backdrop: reactive({
      source: computed(() => api.backdropSource),
      isArtist: computed(() => api.backdropIsArtist),
      backgrounds: computed(() => api.artistBackgrounds),
      index: computed(() =>
        api.artistBackground ? api.artistBackgrounds.indexOf(api.artistBackground) : 0,
      ),
    }),
    lyrics: reactive({
      lines: computed(() => useLyricsStore().lines),
      synced: computed(() => useLyricsStore().synced),
      offset: computed(() => useLyricsStore().offset),
      songKey: computed(() => useLyricsStore().songId),
      loading: computed(() => useLyricsStore().loading),
      status: computed(() => lyricsStatus(api.currentSong?.id ?? null)),
      sourceLabel: computed(() => lyricsSourceLabel()),
      sourceUrl: computed(() => lyricsSourceUrl()),
      credits: computed(() => useLyricsStore().credits),
    }),
    visualizer: reactive({
      available: computed(() => api.visualizerAvailable),
      active: computed(() => api.visualizerActive),
      color: computed(() => api.visualizerColor),
      smoothing: computed(() => api.visualizerSmoothing),
      sample: () => api.visualizerSample(),
      debug: computed(() => api.visualizerDebug),
    }),
    capabilities: reactive({
      seek: true,
      fullscreen: true,
      artistLinks: true,
      titleLog: true,
      autoplay: true,
      debug: computed(() => api.debugEnabled),
      lyricsTools: true,
    }),
    // The app's batched cover component. Kept out of the shared
    // presentation's imports on purpose - it pulls in the library store.
    cover: markRaw(CoverArt),
    // Likewise the title log and the lyrics picker: store-reading, host-only
    // leaves the guest page never renders.
    titleLogComponent: markRaw(RadioTitleLog),
    lyricsCandidateComponent: markRaw(LyricsCandidateList),
    debugOverlayComponent: markRaw(VisualizerDebugOverlay),
    ui: reactive({
      lyricsOpen: computed({
        get: () => api.showLyrics,
        set: (open: boolean) => api.setLyricsOpen(open),
      }),
      showVisualizer: computed(() => api.showVisualizer),
      artworkHidden: computed(() => api.artworkHidden),
    }),
    panels: computed(() => api.cornerPanels),
    searchTitles: (query: string) => api.searchTitleLog(query),
    loadOlderTitles: () => api.loadOlderTitles(),
    setLyricsOpen: (open: boolean) => api.setLyricsOpen(open),
    toggleVisualizer: () => api.toggleVisualizer(),
    toggleArtwork: () => api.toggleArtwork(),
    cycleBackground: () => api.cycleArtistBackground(),
    selectBackdrop: () => {},
    seek: (seconds: number) => api.seek(seconds),
    setLyricsOffset: (offset: number) => api.setLyricsOffset(offset),
    resetLyricsOffset: (offset: number) => api.setLyricsOffset(0 - offset),
    loadLyricsCandidates: () => api.loadLyricsCandidates(),
    clearLyricsCandidates: () => api.clearLyricsCandidates(),
    toggleAutoplay: () => api.toggleAutoplay(),
    autoplayEnabled: () => api.autoplayEnabled,
    addDebugTitle: () => api.addDebugTitle(),
  }) as NowPlayingSource
}
