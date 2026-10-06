<template>
  <now-playing-presentation :compact="compact" />
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useRadioMetadataStore } from '@/stores/radioMetadata'
import { useConnectStore } from '@/stores/connect'
import { useDrawersStore } from '@/stores/drawers'
import { useLibraryStore } from '@/stores/library'
import { useAutoplayStore } from '@/stores/autoplay'
import { useLyricsStore } from '@/stores/lyrics'
import { nowPlayingSourceKey } from '@/components/now-playing/source'
import {
  hostNowPlayingSource,
  toNowPlayingSong,
  type HostNowPlayingApi,
} from '@/components/now-playing/hostSource'
import NowPlayingPresentation from '@/components/now-playing/NowPlayingPresentation.vue'
import type { NowPlayingPanel } from '@/components/now-playing/source'
import { radioFaviconRequest, type RadioFaviconRequest } from '@/services/connect/radio'
import { getLogLevel } from '@/services/connect/logLevel'
import { getArtistArt, nextBackground, rememberBackground } from '@/services/connect/fanart'
import { preloadImage } from '@/services/preloadImage'
import { useFanartStore } from '@/stores/fanart'
import type { RadioTitleEntry } from '@/services/connect/radioMetadata'
import { useAuthStore } from '@/stores/auth'
import { getAudioEngine } from '@/services/audioEngine'
import { VisualizerEventSource } from '@/services/connect/visualizer'
import type { VisualizerFrame } from '@/services/connect/types'
import { BAR_COUNT, MAX_FREQ_HZ, MIN_FREQ_HZ, resampleBands } from '@/services/visualizerBands'
import { extractDominantColor } from '@/services/colorExtractor'
import { visualizerBarColor } from '@/services/visualizerColor'
import { accountScopedKey } from '@/services/accountKey'
import type { Song } from '@/types/library'

// See AudioVisualizer's old comment: local analysis updates every frame,
// the backend's cast frames roughly every 23ms.
const SMOOTHING_LOCAL = 0.3
const SMOOTHING_CAST = 0.3

// Warm amber — the same signal color the app is named after (see main.ts's
// 'beacon' theme) — used whenever there's nothing to extract a color from
// yet (radio has no artwork, or extraction is still in flight/failed). The
// presentation falls back to the same value when the accent goes away.
const FALLBACK_COLOR = '245, 169, 78'

// Persisted across restarts — a one-off UI preference, not session state,
// same "single localStorage key" convention as stores/lyrics.ts's offsets.
const SHOW_VISUALIZER_KEY = 'beacon.showVisualizer'

function readShowVisualizer(): boolean {
  try {
    // Absent (never toggled before) defaults to shown.
    return localStorage.getItem(accountScopedKey(SHOW_VISUALIZER_KEY)) !== 'false'
  } catch {
    return true
  }
}

// Whether the album artwork is hidden so the artist background shows
// through. Only ever takes effect when there is a background to show - see
// artworkHidden - so a preference left on does not hide the artwork for an
// artist Fanart.tv has nothing for.
const HIDE_ARTWORK_KEY = 'beacon.nowPlayingHideArtwork'

function readHideArtwork(): boolean {
  try {
    // Absent (never toggled before) defaults to hidden: with a Fanart.tv
    // background there is something better to look at than the album cover,
    // and without one artworkHidden stays false anyway, so the cover still
    // shows. Toggling it stores the choice either way.
    return localStorage.getItem(accountScopedKey(HIDE_ARTWORK_KEY)) !== 'false'
  } catch {
    return true
  }
}

// How long before a track ends the corner starts announcing the next one
// (see nextUpActive) - long enough to read, short enough to still feel like
// "about to change".
const NEXT_UP_SECONDS = 15

/** Fake artist/track pairs for the toolbar's debug button. Shaped like a
 * song on purpose, so a press exercises the row the log spends its time
 * drawing - split into artist and track, with the search button that comes
 * with it - rather than the plain one-line fallback. */
const DEBUG_TITLES: [string, string][] = [
  ['Lorem Ipsum', 'Dolor Sit Amet'],
  ['Consectetur', 'Adipiscing Elit'],
  ['Sed Do Eiusmod', 'Tempor Incididunt'],
  ['Ut Labore', 'Et Dolore Magna'],
]

// Debounces the title-log search box. Module-level like SongsView.vue's own
// debounce timer, and for the same reason: one search box per instance, and
// a timer that cannot outlive the component that armed it.
const TITLE_LOG_SEARCH_DEBOUNCE_MS = 200
let titleLogSearchTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'NowPlayingView',
  components: { NowPlayingPresentation },
  props: {
    // Set by MobileNowPlayingView.vue — which of the two stage components
    // renders, the view's own height, and the toolbar's compact layout all
    // key off it. The phone's stage is squeezed under a mobile
    // transport-controls block and tab bar instead of the near-full-viewport
    // height the desktop one gets between the app-bar and PlayerBar.vue, so
    // its sizing differs; everything else (backdrop, toolbar, visualizer,
    // flip mechanics) is shared.
    compact: {
      type: Boolean,
      default: false,
    },
  },
  provide() {
    // The presentation (stages, toolbar, lyrics, visualizer) reads this
    // instead of the stores, so the guest page can hand it its own. Built
    // around this view, which keeps owning the stores and the host-only
    // lookups.
    return {
      [nowPlayingSourceKey]: hostNowPlayingSource(this as unknown as HostNowPlayingApi),
    }
  },
  data() {
    return {
      // Both belong to the debug button in the toolbar — see its own
      // comment. Off, and empty, for everyone who is not chasing something.
      debugEnabled: false,
      debugTitles: [] as RadioTitleEntry[],
      // "r, g, b" — kept as a CSS-ready string so the two computed styles
      // below don't each redo the same join().
      extractedColor: null as string | null,
      // The visualizer's own data source (moved out of AudioVisualizer so
      // the guest page can share the bars without the audio engine): a
      // Web Audio analyser during local playback, the backend's frames
      // while casting.
      frequencyData: null as Uint8Array<ArrayBuffer> | null,
      visualizerEvents: null as VisualizerEventSource | null,
      castBands: null as number[] | null,
      visualizerDebug: null as VisualizerFrame['debug'] | null,
      // The current song's artist background from Fanart.tv, when the
      // installation has a key and the artist has one. Shown crisp behind
      // everything (see .now-playing__backdrop--artist); null falls back to
      // the blurred cover art.
      artistBackground: null as string | null,
      // Every background Fanart.tv has for the current artist, the shown
      // one among them - what the toolbar's cycle button steps through.
      artistBackgrounds: [] as string[],
      // The artist background's own dominant colour, extracted for the
      // visualizer bars only - see visualizerColor.
      artistColor: null as string | null,
      // Which artist the current background belongs to, so a new track by
      // the same artist can swap the picture without first dropping to the
      // cover (see loadArtistBackground).
      backgroundArtist: '',
      // The next track's Fanart.tv answer, fetched and preloaded ahead of the
      // change (see preloadNext) and consumed by loadArtistBackground on the
      // change itself, so the new backdrop is there on the first frame
      // instead of the blurred cover showing while a lookup runs. Keyed by
      // artist; a missing key (undefined) is "not preloaded", a null value is
      // "preloaded, this artist has no art".
      preloadedArt: {} as Record<string, Awaited<ReturnType<typeof getArtistArt>> | null>,
      showVisualizer: readShowVisualizer(),
      // The user's wish to hide the artwork; only honored while there is a
      // Fanart.tv background to reveal (see artworkHidden).
      hideArtwork: readHideArtwork(),
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    radioMeta() {
      return useRadioMetadataStore()
    },
    drawersStore() {
      return useDrawersStore()
    },
    autoplayStore() {
      return useAutoplayStore()
    },
    authStore() {
      return useAuthStore()
    },
    lyricsStore() {
      return useLyricsStore()
    },
    currentSong() {
      return this.playbackStore.currentSong
    },
    radioStation() {
      return this.playbackStore.radioStation
    },
    isPlaying(): boolean {
      return this.playbackStore.isPlaying
    },
    localPosition(): number {
      return this.playbackStore.localPosition
    },
    duration(): number {
      return this.playbackStore.duration
    },
    autoplayEnabled(): boolean {
      return this.autoplayStore.enabled
    },
    // The radio snapshot fields the source hands the log panel, lifted here
    // so hostSource reads them the same way it reads everything else.
    radioNowPlaying(): string | null {
      return this.radioMeta.nowPlaying
    },
    radioTitleLogComplete(): boolean {
      return this.radioMeta.titleLogComplete
    },
    radioSearchQuery(): string {
      return this.radioMeta.searchQuery
    },
    radioSearchPending(): boolean {
      return this.radioMeta.searchPending
    },
    radioHasActiveSearch(): boolean {
      return this.radioMeta.hasActiveSearch
    },
    currentArtist(): string {
      return this.currentSong?.artist ?? ''
    },
    fanartEnabled(): boolean {
      return useFanartStore().enabled
    },
    hasPlayable() {
      return this.currentSong != null || this.playbackStore.radioStation != null
    },
    /** The song the queue would play after the current one, or null when
     * there is none (radio, repeat-one, or the end of a non-looping queue).
     * The store's own nextIndex() is the one place that knows about repeat
     * and wrapping - this only turns its answer into a song. */
    nextSong(): Song | null {
      const playback = this.playbackStore
      if (playback.radioStation || playback.repeatMode === 'one') return null
      const index = playback.nextIndex(1)
      return index === null ? null : (playback.queue[index] ?? null)
    },
    /** Whether the corner should announce that next song: a wide screen (a
     * phone has no room for a second card - only the preload matters there),
     * the artwork hidden (that is where the small cover + labels live), a
     * next one, and the current track within NEXT_UP_SECONDS of its end. */
    nextUpActive(): boolean {
      if (this.compact || !this.artworkHidden || !this.nextSong || !this.playbackStore.isPlaying) {
        return false
      }
      const duration = this.playbackStore.duration
      const position = this.playbackStore.localPosition
      return duration > 0 && duration - position <= NEXT_UP_SECONDS
    },
    /** The panels the corner stack renders, left to right: the one playing,
     * then - near the end of a track - animated chevrons and the next track
     * (see nextUpActive). On the change the next panel slides left into the
     * current's place (see the next-up transition in <style>). With the
     * artwork shown there is a single panel - the labels under the artwork -
     * and no chevrons. */
    cornerPanels(): NowPlayingPanel[] {
      const panels: NowPlayingPanel[] = []
      if (this.currentSong) {
        panels.push({
          key: this.currentSong.id,
          kind: 'song',
          song: toNowPlayingSong(this.currentSong),
          eyebrow: this.eyebrow,
          title: this.currentSong.title,
          radioTag: null,
        })
      } else if (this.playbackStore.radioStation) {
        // The ICY tag (what's playing right now) is the prominent title and
        // the station is the secondary line — same as SongInfo.vue's own
        // player-bar label. Without a tag the station name is all there is,
        // so it sits up top and no second line repeats it.
        const stationName = this.playbackStore.radioStation.name
        const nowPlaying = this.radioMeta.nowPlaying
        panels.push({
          key: 'radio',
          kind: 'song',
          song: null,
          eyebrow: this.eyebrow,
          title: nowPlaying ?? stationName,
          radioTag: nowPlaying ? stationName : null,
        })
      }
      if (this.nextUpActive && this.nextSong) {
        panels.push({
          key: 'chevrons',
          kind: 'chevrons',
          song: null,
          eyebrow: '',
          title: '',
          radioTag: null,
        })
        panels.push({
          key: this.nextSong.id,
          kind: 'song',
          song: toNowPlayingSong(this.nextSong),
          eyebrow: this.$t('home.nextUp'),
          title: this.nextSong.title,
          radioTag: null,
        })
      }
      return panels
    },
    // Kept in the store rather than in this view's own data, because this
    // view is unmounted every time the user goes anywhere else and the
    // panel is expected to be as they left it when they come back — a
    // click on a title in a station's log leaves for the search page and
    // is meant to be followed by Back.
    //
    // The only lyrics state in the app. There used to be a second
    // presentation - a drawer sliding the same content over whatever page
    // was being browsed - with a flag of its own that this view shared;
    // both are gone (2026-09-06). PlayerBar's button now brings the user
    // here instead of opening anything of its own, so there is one place
    // this content lives and one thing to remember about it. See the
    // store's own comment on lyricsPanelOpen.
    showLyrics: {
      get(): boolean {
        return this.drawersStore.lyricsPanelOpen
      },
      set(value: boolean) {
        this.drawersStore.lyricsPanelOpen = value
      },
    },
    /** The station's own log, with anything the toolbar's debug button has
     * invented on top of it. Empty for everyone else, so this is the
     * store's list unchanged - and because it is one prop, a made-up title
     * reaches the log exactly the way a real one does, animation included.
     */
    titleLogEntries(): RadioTitleEntry[] {
      // A search answers from the backend's whole log, so its results
      // replace the list rather than filtering the one on screen — see
      // the radio-metadata store's search(). The debug titles stay out of
      // it: they exist to exercise the timeline's own rendering and were
      // never in the log being searched.
      if (this.radioMeta.hasActiveSearch) return this.radioMeta.searchResults
      const log = this.radioMeta.titleLog
      return this.debugTitles.length ? [...this.debugTitles, ...log] : log
    },
    // Radio has no track for the backend to analyze while casting to
    // AirPlay (see routes/playback.py's /play-url) and nothing honest to
    // show but a fake animation, even though casting a station is routed
    // through connect's own relay by default now (core/radio_relay.py),
    // which *does* decode a real PCM stream this could tap
    // (core/visualizer_feed.py's own radio branch, wired up and tested —
    // see AudioAnalyzer's pcm_source parameter). AirPlay has no position
    // to poll for radio at all, so it gets the "honestly absent" treatment
    // decided live 2026-09-01, after shipping a guessed-constant version
    // and measuring it roughly a second off and station-dependent.
    // Chromecast and DLNA do report a real position for radio (measured
    // live 2026-09-02, see connect/core/radio_position.py), Sonos does not
    // (its radio goes out over x-rincon-mp3radio:// and reports a flat
    // 0.00s, see delivery/sonos.py). None of that is decided here: the
    // backend answers it per target (core/state.py). It is moot for now
    // either way — connect.ts's RADIO_VISUALIZER_ENABLED answers false for
    // every type, off again after the 2026-09-07 measurements, so all
    // three fall into the same "honestly absent" treatment as AirPlay.
    // See connect.ts, and docs/investigations/radio-visualizer-cast-sync.md
    // for why that is not one constant away from working.
    visualizerAvailable() {
      // Casting reads its frequency data from the backend rather than from
      // this device's own audio, so it needs no local analyser at all —
      // which is what makes it available on a phone, where there is none
      // (see webAudioAllowed() in services/audioEngine.ts).
      if (this.playbackStore.isCasting) {
        if (this.currentSong) return true
        const connectStore = useConnectStore()
        return connectStore.activeTargets.some((t) => connectStore.isRadioPositionCapable(t))
      }
      return getAudioEngine().hasAnalyser
    },
    visualizerActive() {
      return this.hasPlayable && this.showVisualizer && this.visualizerAvailable
    },
    /** 'local' has a real <audio> element to tap, 'cast' gets real data from
     * the backend instead — see AudioVisualizer's old comment. */
    visualizerMode(): 'local' | 'cast' | 'idle' {
      if (!this.visualizerActive) return 'idle'
      if (!this.playbackStore.isPlaying) return 'idle'
      return this.playbackStore.isCasting ? 'cast' : 'local'
    },
    visualizerSmoothing(): number {
      return this.visualizerMode === 'cast' ? SMOOTHING_CAST : SMOOTHING_LOCAL
    },
    eyebrow() {
      if (this.currentSong)
        return this.playbackStore.isPlaying ? this.$t('home.nowPlaying') : this.$t('home.paused')
      if (this.playbackStore.radioStation) return this.$t('home.radioEyebrow')
      return ''
    },
    /** Feeds the backdrop and the colour extraction, not the artwork on
     * screen — that one is <cover-art> above with its own size. 300 because
     * every backdrop in the app asks for that (see docs/styleguide.md), so
     * they share one cached image instead of each holding a private
     * resolution. */
    coverArtUrl(): string | null {
      const id = this.currentSong?.coverArtId
      return id ? useLibraryStore().client().coverArtUrl(id, 300) : null
    },
    /** What the full-bleed backdrop actually shows: the artist's Fanart.tv
     * background when there is one, else the blurred cover art. */
    backdropSource(): string | null {
      return this.artistBackground ?? this.coverArtUrl
    },
    backdropIsArtist(): boolean {
      return Boolean(this.artistBackground)
    },
    /** Whether there is more than one background to step through - with a
     * single one (or none) the toolbar's cycle button would do nothing. */
    canCycleBackground(): boolean {
      return this.artistBackgrounds.length > 1
    },
    // The biggest single spot in the whole app for one of these — 512 asks
    // for whatever's largest a station's homepage actually declares (see
    // routes/radio.py's _select()), same reasoning as PlayerBar's own
    // radioFavicon but with more headroom given how large this renders.
    // Both land on the same size step (see faviconSizeStep), so the two
    // views showing one station at once cost one lookup between them.
    radioFavicon(): RadioFaviconRequest | null {
      const station = this.playbackStore.radioStation
      if (!station?.homePageUrl && !station?.favicon) return null
      return radioFaviconRequest(station.homePageUrl ?? '', 512, station.favicon ?? '')
    },
    colorTriplet(): string {
      return this.extractedColor ?? FALLBACK_COLOR
    },
    /** The visualizer bars' colour: the artist background's own dominant
     * colour, but only once a Fanart.tv background is actually loaded and
     * its colour extracted - the fixed amber otherwise. Lifted for
     * visibility by visualizerBarColor(), which also falls back to amber for
     * a grey or dark background the bars would vanish into. Deliberately not
     * colorTriplet, which follows the cover and drives the ambient wash and
     * glow. */
    visualizerColor(): string {
      return visualizerBarColor(this.artistBackground ? this.artistColor : null)
    },
    /** Whether the artwork is actually hidden right now: the wish, and a
     * Fanart.tv artist background that is loaded and ready to show instead.
     * Without one the artwork stays - hiding it would leave nothing. */
    artworkHidden(): boolean {
      return this.hideArtwork && Boolean(this.artistBackground)
    },
    // A soft, wide wash filling the whole screen — the "room" the artwork
    // sits in reacts to whatever's playing, the same idea as the lighthouse
    // in the app's own name: the light changes color with what it's
    // guiding you through. Sits *over* the backdrop above as a semi-
    // transparent tint (matching DetailHeader's own 0.55 scrim opacity),
    // not an opaque fill — the blurred artwork needs to still show through.
    ambientStyle() {
      // Hiding the artwork is a wish to look at the artist background, so
      // the darkening goes with it.
      if (this.artworkHidden) return { background: 'none' }
      // Over the artist's photo the darkening stays but the colour does
      // not: the cover's colour (or the amber fallback) over a sharp photo
      // reads as a colour cast. The glow behind the artwork keeps the light.
      if (this.backdropIsArtist) return { background: 'rgba(18, 20, 28, 0.55)' }
      return {
        background: `radial-gradient(ellipse 65% 55% at 50% 32%, rgba(${this.colorTriplet}, 0.35), rgba(18, 20, 28, 0) 70%), rgba(18, 20, 28, 0.55)`,
      }
    },
    // A tighter, brighter halo immediately behind the artwork — a light
    // source rather than a room tint, layered on top of ambientStyle.
    glowColor() {
      return `radial-gradient(circle, rgba(${this.colorTriplet}, 0.55) 0%, rgba(${this.colorTriplet}, 0) 70%)`
    },
  },
  watch: {
    coverArtUrl: {
      immediate: true,
      handler(url: string | null) {
        this.extractedColor = null
        if (url) this.loadColor(url)
      },
    },
    // Turning Fanart.tv off drops the background (and the artwork it may be
    // revealed by) immediately; turning it back on fetches it again.
    fanartEnabled() {
      void this.loadArtistBackground(this.currentArtist)
    },
    /** Made-up titles belong to the station they were invented for - see
     * the toolbar's debug button. Left behind, they would sit at the top
     * of the next station's log looking like something it had played. */
    'playbackStore.radioStation'() {
      if (this.debugTitles.length) this.debugTitles = []
    },
    // Also fires the instant lyrics are actually opened, in case the
    // currentSong watcher below hasn't resolved yet (a fresh song whose
    // fetch is still in flight) — ensureLoaded() is idempotent/cache-aware
    // (see its own comment in stores/lyrics.ts), so calling it again here
    // is a cheap no-op once the preload below has already landed.
    showLyrics(show: boolean) {
      if (show && this.currentSong) useLyricsStore().ensureLoaded(this.currentSong)
    },
    // Unconditional (not just "if already showing lyrics") and immediate —
    // preloads every song's lyrics as soon as it becomes current, not only
    // once the user actually opens the lyrics view. Without this, flipping
    // the card over (see .now-playing__flip-card) showed its back face
    // sitting on a loading state for however long the fetch took, instead
    // of the lyrics already being there the moment the flip finishes.
    currentSong: {
      immediate: true,
      handler(song: Song | null) {
        // A new track gets a fresh pick from the artist's images, even when
        // the artist is unchanged: the backend hands back one of the five
        // most-liked at random (see core/fanart.py's _choose), so this is
        // what keeps the background from being the same picture all album.
        void this.loadArtistBackground(this.currentArtist)
        // Radio has no lyrics, but it does have a title log to put in the
        // same panel (see the template) — so only *nothing playing at all*
        // still falls back to the plain artwork view. Reading
        // Reading the store here (as the rest of this view does) rather
        // than assuming an order: which of the two is set first when
        // switching to a station isn't guaranteed, and this runs on the
        // currentSong half of it.
        if (!song) {
          if (!this.playbackStore.radioStation) this.showLyrics = false
          return
        }
        useLyricsStore().ensureLoaded(song)
      },
    },
    // Warms the next track's Fanart.tv background as soon as the queue says
    // what it is, so the change itself has nothing left to load - see
    // preloadNext().
    nextSong: {
      immediate: true,
      handler(song: Song | null) {
        void this.preloadNext(song)
      },
    },
    showVisualizer(value: boolean) {
      try {
        localStorage.setItem(accountScopedKey(SHOW_VISUALIZER_KEY), String(value))
      } catch {
        // Non-critical — worst case the preference doesn't survive to the
        // next launch.
      }
    },
    hideArtwork(value: boolean) {
      try {
        localStorage.setItem(accountScopedKey(HIDE_ARTWORK_KEY), String(value))
      } catch {
        // Non-critical — worst case the preference doesn't survive to the
        // next launch.
      }
    },
    visualizerMode: {
      immediate: true,
      handler(mode: 'local' | 'cast' | 'idle') {
        if (mode === 'cast') this.startVisualizerEvents()
        else this.stopVisualizerEvents()
      },
    },
  },
  beforeUnmount() {
    this.stopVisualizerEvents()
  },
  mounted() {
    // Best-effort, exactly as VisualizerDebugOverlay.vue does it: a failed
    // call just leaves the debug button away, which is the right outcome
    // for anyone who was not looking for it.
    getLogLevel()
      .then(({ level }) => {
        this.debugEnabled = level === 'DEBUG' || level === 'TRACE'
      })
      .catch(() => {})
  },
  methods: {
    /** Hands a keystroke to the store, 200ms after the last one — the same
     * delay every other search box in the app waits (SongsView.vue). This
     * one reaches the backend rather than a local array, so the wait is
     * doing more work here; what makes it safe is that the store's own
     * sequence guard decides which answer counts, not the order they
     * arrive in. Cleared eagerly so a search dropped mid-typing does not
     * fire one last time after the field is already closed. */
    searchTitleLog(query: string): void {
      clearTimeout(titleLogSearchTimer)
      if (!query) {
        this.radioMeta.clearSearch()
        return
      }
      titleLogSearchTimer = setTimeout(() => {
        void this.radioMeta.search(query)
      }, TITLE_LOG_SEARCH_DEBOUNCE_MS)
    },
    // The source's actions. Thin, because the view keeps owning the
    // underlying stores; they exist so the shared presentation can call
    // them without importing one.
    setLyricsOpen(open: boolean): void {
      this.showLyrics = open
    },
    toggleVisualizer(): void {
      this.showVisualizer = !this.showVisualizer
    },
    toggleArtwork(): void {
      this.hideArtwork = !this.hideArtwork
    },
    loadOlderTitles(): void {
      void this.radioMeta.loadOlder()
    },
    setLyricsOffset(offset: number): void {
      this.lyricsStore.setOffset(offset)
    },
    loadLyricsCandidates(): void {
      if (this.currentSong) void this.lyricsStore.loadCandidates(this.currentSong)
    },
    clearLyricsCandidates(): void {
      this.lyricsStore.clearCandidates()
    },
    seek(seconds: number): void {
      void this.playbackStore.seek(seconds)
    },
    toggleAutoplay(): void {
      this.playbackStore.setAutoplayEnabled(!this.autoplayStore.enabled)
    },
    /** One made-up title, handed to the log the way a real one arrives —
     * see the debug button in the toolbar. The counter goes in the title
     * because two presses inside the same second would otherwise produce
     * the same row key, and the log would take the second one for the
     * first still sitting there rather than for something new. */
    addDebugTitle(): void {
      const [artist, track] = DEBUG_TITLES[this.debugTitles.length % DEBUG_TITLES.length]!
      this.debugTitles = [
        { title: `${artist} - ${track} ${this.debugTitles.length + 1}`, at: Date.now() / 1000 },
        ...this.debugTitles,
      ]
    },
    /** Starts the backend's real-time frames while casting. */
    startVisualizerEvents() {
      if (this.visualizerEvents) return
      const auth = this.authStore
      this.visualizerEvents = new VisualizerEventSource(
        auth.apiUrl,
        auth.connectToken,
        auth.sessionId,
      )
      this.visualizerEvents.onFrame = (frame: VisualizerFrame) => {
        this.castBands = frame.bands
        this.visualizerDebug = frame.debug ?? null
      }
      this.visualizerEvents.start()
    },
    stopVisualizerEvents() {
      this.visualizerEvents?.stop()
      this.visualizerEvents = null
      this.castBands = null
      this.visualizerDebug = null
    },
    /** What VisualizerBars reads every frame. */
    visualizerSample(): number[] | null {
      return this.visualizerMode === 'local'
        ? this.sampleFrequencies()
        : resampleBands(this.castBands)
    },
    // Raw FFT bins are linearly spaced in frequency, but pitch/perceived
    // "spread" of musical content is logarithmic — each bar instead covers
    // its own logarithmically-spaced slice (MIN_FREQ_HZ..MAX_FREQ_HZ),
    // matching connect/core/audio_analysis.py's analyze_pcm() for 'cast'
    // mode so both read the same.
    sampleFrequencies(): number[] | null {
      let analyser: AnalyserNode
      try {
        analyser = getAudioEngine().getAnalyser()
      } catch (error) {
        console.error('[now-playing] Web Audio analyser unavailable:', error)
        return null
      }
      if (!this.frequencyData || this.frequencyData.length !== analyser.frequencyBinCount) {
        this.frequencyData = new Uint8Array(analyser.frequencyBinCount)
      }
      analyser.getByteFrequencyData(this.frequencyData)
      const binHz = analyser.context.sampleRate / analyser.fftSize
      const bins = this.frequencyData
      const ratio = MAX_FREQ_HZ / MIN_FREQ_HZ
      const heights = Array.from<number>({ length: BAR_COUNT })
      for (let i = 0; i < BAR_COUNT; i++) {
        const loFreq = MIN_FREQ_HZ * ratio ** (i / BAR_COUNT)
        const hiFreq = MIN_FREQ_HZ * ratio ** ((i + 1) / BAR_COUNT)
        const loBin = Math.max(0, Math.floor(loFreq / binHz))
        const hiBin = Math.min(bins.length, Math.max(loBin + 1, Math.ceil(hiFreq / binHz)))
        let sum = 0
        for (let bin = loBin; bin < hiBin; bin++) sum += bins[bin] ?? 0
        heights[i] = sum / (hiBin - loBin) / 255
      }
      return heights
    },
    async loadColor(url: string) {
      const color = await extractDominantColor(url)
      // The song may have changed again while the image was loading —
      // don't let a stale extraction overwrite whatever's current now.
      if (url !== this.coverArtUrl) return
      this.extractedColor = color ? color.join(', ') : null
    },
    /** The current song's artist background, fetched per artist. Cleared
     * first, so the previous artist's image never sits behind a new song
     * while this one is still in flight. Same stale-response guard as
     * loadColor() above, keyed on the artist. */
    async loadArtistBackground(artist: string) {
      // A preloaded answer (see preloadNext) is used before any await, so the
      // new backdrop - and with it the hidden artwork - is there on the first
      // frame of the new track instead of dropping to the blurred cover while
      // a lookup runs.
      const preloaded = this.preloadedArt[artist]
      if (preloaded !== undefined) {
        delete this.preloadedArt[artist]
        this.artistBackground = preloaded?.background ?? null
        this.artistBackgrounds = preloaded?.backgrounds ?? []
        this.backgroundArtist = artist
        this.artistColor = null
        if (this.artistBackground) {
          const color = await extractDominantColor(this.artistBackground)
          if (this.currentArtist !== artist) return
          this.artistColor = color ? color.join(', ') : null
        }
        return
      }
      // A different artist's picture must not stay behind the new one while
      // this loads. A new *track* by the same artist keeps the current
      // picture instead, so the swap is one crossfade rather than fading to
      // the cover and back.
      const sameArtist = this.backgroundArtist === artist
      if (!sameArtist) {
        this.artistBackground = null
        this.artistBackgrounds = []
        this.artistColor = null
        this.backgroundArtist = ''
      }
      if (!useFanartStore().enabled || !artist) return
      let art: Awaited<ReturnType<typeof getArtistArt>> = null
      try {
        art = await getArtistArt(artist)
      } catch (error) {
        console.error('[now-playing] Fanart.tv lookup failed:', error)
      }
      if (this.currentArtist !== artist) return
      // Preload before setting it: the backdrop crossfades to the artist
      // image, and that only reads as a fade if the image is already
      // paintable when the swap happens.
      if (art?.background) await preloadImage(art.background)
      if (this.currentArtist !== artist) return
      this.artistBackground = art?.background ?? null
      this.artistBackgrounds = art?.backgrounds ?? []
      this.backgroundArtist = artist
      // The bars take this image's colour (see visualizerColor); extracted
      // here rather than from the cover, which is what the ambient wash and
      // glow stay on.
      if (this.artistBackground) {
        const color = await extractDominantColor(this.artistBackground)
        if (this.currentArtist !== artist) return
        this.artistColor = color ? color.join(', ') : null
      }
    },
    /** Steps to the next of the artist's Fanart.tv backgrounds - the
     * toolbar's cycle button. Walks the same candidate list the shown one
     * was picked from, so every press lands on a different image. */
    async cycleArtistBackground() {
      const next = nextBackground(this.artistBackgrounds, this.artistBackground)
      if (!next) return
      const artist = this.backgroundArtist
      // Preloaded before the swap for the same reason as loadArtistBackground:
      // the backdrop only crossfades if the image is already paintable.
      await preloadImage(next)
      // The track may have moved on while the image loaded.
      if (this.backgroundArtist !== artist) return
      this.artistBackground = next
      rememberBackground(artist, next)
      const color = await extractDominantColor(next)
      if (this.artistBackground !== next) return
      this.artistColor = color ? color.join(', ') : null
    },
    /** Fetches and preloads the *next* track's Fanart.tv background, so the
     * change itself has nothing left to load. The answer is kept for
     * loadArtistBackground to use straight away (see preloadedArt). One
     * entry only - the next track is the only one this is ever for.
     * Best-effort: with nothing next, no key, or a failed lookup it does
     * nothing, and the next track loads its own images as usual. */
    async preloadNext(song: Song | null) {
      if (!song || !useFanartStore().enabled) return
      try {
        const art = await getArtistArt(song.artist)
        this.preloadedArt = { [song.artist]: art }
        if (art?.background) await preloadImage(art.background)
      } catch (error) {
        console.error('[now-playing] Next-track Fanart.tv preload failed:', error)
      }
    },
  },
}
</script>
