import type { InjectionKey } from 'vue'
import type { RadioFaviconRequest } from '@/services/connect/radio'
import type { RadioTitleEntry } from '@/services/connect/radioMetadata'
import type { VisualizerFrame } from '@/services/connect/types'
import type { LyricLine } from '@/services/lyrics/parseLrc'

/** A song as the Now Playing presentation needs it - the app's own Song
 * trimmed to what is shown, plus a ready image URL for the guest page, which
 * has no library store to build one from. */
export interface NowPlayingSong {
  id: string
  title: string
  artist: string
  album: string
  artistId: string
  albumId: string
  /** The app's own cover id, resolved (and batched) by CoverArt. */
  coverArtId: string | null
  /** A ready image URL, used as-is instead of coverArtId (the guest page).
   * Never goes through the app's cover batch, which needs the app token. */
  coverUrl: string | null
  /** Who wished for it (party only). */
  wishedBy?: string | null
}

export interface NowPlayingRadio {
  name: string
  /** The station's ICY "now playing" tag, while it sends one. */
  nowPlaying: string | null
  /** The app's batched favicon request; null for guests. */
  favicon: RadioFaviconRequest | null
  /** A ready logo URL, used as-is (the guest page). */
  logoUrl: string | null
  /** The station's log, as the log panel renders it; empty for guests
   * (capabilities.titleLog is off then). */
  titleLog: RadioTitleEntry[]
  titleLogComplete: boolean
  searchQuery: string
  searchPending: boolean
  hasActiveSearch: boolean
}

export interface NowPlayingLyrics {
  lines: LyricLine[]
  synced: boolean
  /** Seconds to shift the lines by (positive is later). */
  offset: number
  songKey: string | null
  loading: boolean
  /** A line to show where there are no lines yet / none found, or null. */
  status: string | null
  sourceLabel: string | null
  sourceUrl: string | null
  credits: string[]
}

export interface NowPlayingBackdrop {
  /** What the full-bleed image shows: the artist background, else the cover. */
  source: string | null
  isArtist: boolean
  /** Every background to step through; a guest steps on its own. */
  backgrounds: string[]
  index: number
}

export interface NowPlayingVisualizer {
  available: boolean
  active: boolean
  /** "r, g, b" - the bars' colour. */
  color: string
  /** How far each bar moves toward its target per frame - lower is
   * smoother. Local analysis updates every frame, cast roughly every 23ms. */
  smoothing: number
  /** What the bars read each frame: the audio engine during local playback,
   * the backend's frames while casting, the guest page's own SSE feed. */
  sample: () => number[] | null
  /** The debug payload of the latest frame, where the backend sends one. */
  debug: VisualizerFrame['debug'] | null
}

/** What a given host allows the presentation to do. The app turns everything
 * on; the guest page turns all of it off except fullscreen. */
export interface NowPlayingCapabilities {
  /** Click a lyric line to seek. */
  seek: boolean
  fullscreen: boolean
  /** Turn artist/album names into links to their pages. */
  artistLinks: boolean
  /** A station's title log in place of the lyrics. */
  titleLog: boolean
  /** The autoplay toggle (only ever shown in fullscreen). */
  autoplay: boolean
  /** The toolbar's made-up-title button, only where the backend is at
   * DEBUG/TRACE. */
  debug: boolean
  /** The lyrics toolbar: calibrate, sync offset, match picker. */
  lyricsTools: boolean
}

export interface NowPlayingUi {
  lyricsOpen: boolean
  showVisualizer: boolean
  artworkHidden: boolean
}

/** One card in the corner stack. Resolved to display values so the panel
 * component stays presentational. */
export interface NowPlayingPanel {
  key: string
  kind: 'song' | 'chevrons'
  song: NowPlayingSong | null
  eyebrow: string
  title: string
  /** The station name, shown as the secondary line only when an ICY tag is
   * what the title shows. Null otherwise. */
  radioTag: string | null
}

/** Everything the Now Playing presentation reads, so no part of it has to
 * import the host's stores. Built by `hostSource.ts` for the app and
 * `party/guestSource.ts` for the party guests. */
export interface NowPlayingSource {
  song: NowPlayingSong | null
  radio: NowPlayingRadio | null
  next: NowPlayingSong | null
  playing: boolean
  /** Seconds, kept current. */
  position: number
  duration: number
  /** "r, g, b" - drives the glow and the ambient wash. */
  accentColor: string
  glowColor: string
  ambientStyle: Record<string, string>
  backdrop: NowPlayingBackdrop
  lyrics: NowPlayingLyrics
  visualizer: NowPlayingVisualizer
  capabilities: NowPlayingCapabilities
  ui: NowPlayingUi
  /** The corner stack: the current song, then the next one near the end of
   * a track. */
  panels: NowPlayingPanel[]
  /** The radio log's search, and its paging. */
  searchTitles(query: string): void
  loadOlderTitles(): void
  setLyricsOpen(open: boolean): void
  toggleVisualizer(): void
  toggleArtwork(): void
  cycleBackground(): void
  /** The guest page steps through the artist's backgrounds on its own. */
  selectBackdrop(index: number): void
  seek(seconds: number): void
  setLyricsOffset(seconds: number): void
  resetLyricsOffset(offset: number): void
  /** Host only: the match picker's candidates. */
  loadLyricsCandidates(): void
  clearLyricsCandidates(): void
  toggleAutoplay(): void
  autoplayEnabled(): boolean
  /** Host only: hand the title log a made-up title (the debug button). */
  addDebugTitle(): void
}

export const nowPlayingSourceKey: InjectionKey<NowPlayingSource> = Symbol('nowPlayingSource')
