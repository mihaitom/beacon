<template>
  <div
    ref="root"
    class="now-playing"
    :class="{ 'now-playing--compact': compact, 'now-playing--artwork-hidden': artworkHidden }"
  >
    <now-playing-backdrop
      :source="backdropSource"
      :is-artist="backdropIsArtist"
      :scrim-style="ambientStyle"
    />

    <now-playing-toolbar
      :compact="compact"
      :is-fullscreen="isFullscreen"
      :show-visualizer="showVisualizer"
      :visualizer-available="visualizerAvailable"
      :artist-background="artistBackground"
      :can-cycle-background="canCycleBackground"
      :artwork-hidden="artworkHidden"
      :debug-enabled="debugEnabled"
      @toggle-visualizer="showVisualizer = !showVisualizer"
      @toggle-artwork="hideArtwork = !hideArtwork"
      @cycle-background="cycleArtistBackground"
      @toggle-fullscreen="toggleFullscreen"
      @add-debug-title="addDebugTitle"
    />

    <!-- The container-query host — see the stage components' own artSize
     - comments. .now-playing's own grid (see <style>, grid-template-rows:
     - minmax(0, 1fr) auto) is what makes this take up exactly whatever's left
     - after the visualizer row, and container-type: size is what lets
     - artSize/.now-playing__content--split etc. measure *that* real,
     - instead of the raw viewport (vh/vw), which had no idea how much of
     - itself the app-bar/PlayerBar/visualizer row had already taken.
     - A separate element from .now-playing__content on purpose — an
     - element can't size *itself* using its own cqh/cqw units (circular,
     - the browser just ignores it), so this one only ever gets plain flex
     - sizing, and .now-playing__content (and everything inside it)
     - measures against this ancestor instead. -->
    <div ref="stage" class="now-playing__stage">
      <!-- Each mode's stage is its own component (see
       - NowPlayingStageMobile.vue / NowPlayingStageDesktop.vue): their
       - layouts share almost nothing. `compact` is fixed per route (the
       - mobile shell hardcodes it), so this never swaps on a mounted view —
       - no live remount. -->
      <now-playing-stage-mobile
        v-if="compact"
        :artwork-hidden="artworkHidden"
        :glow-color="glowColor"
        :visualizer-color="visualizerColor"
        :radio-favicon="radioFavicon"
        :panels="cornerPanels"
        :title-log-entries="titleLogEntries"
        @search="searchTitleLog"
      />
      <now-playing-stage-desktop
        v-else
        :artwork-hidden="artworkHidden"
        :glow-color="glowColor"
        :visualizer-color="visualizerColor"
        :radio-favicon="radioFavicon"
        :panels="cornerPanels"
        :title-log-entries="titleLogEntries"
        @search="searchTitleLog"
      />
    </div>

    <!-- Real audio-reactive either way: a local Web Audio analyser during
     - local playback, or the backend's own real-time analysis (see
     - connect/core/audio_analysis.py) while casting to a target it can
     - actually run against — see visualizerAvailable for which can't. The
     - row itself lives in NowPlayingVisualizer.vue (its own height
     - transition, mount/hide delay and compact height). -->
    <now-playing-visualizer
      :active="visualizerActive"
      :color="visualizerColor"
      :compact="compact"
      @debug-frame="visualizerDebug = $event"
    />

    <!-- Positioned in .now-playing's own layout (which is already
     - `position: relative`, see its own CSS), not inside <audio-visualizer>
     - or .now-playing__visualizer-row above — see VisualizerDebugOverlay's
     - own comment for why living inside AudioVisualizer either covered the
     - bars or compressed them, reported live 2026-09-05 both times. This
     - way it can never do either: it takes no layout space from the
     - visualizer row at all, floating over whatever's underneath instead
     - (the artwork/backdrop area, not the bars themselves, for the
     - top-left corner this actually renders in). -->
    <visualizer-debug-overlay :debug="visualizerDebug" class="now-playing__visualizer-debug" />
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useRadioMetadataStore } from '@/stores/radioMetadata'
import { useConnectStore } from '@/stores/connect'
import { useDrawersStore } from '@/stores/drawers'
import { useLibraryStore } from '@/stores/library'
import { useLyricsStore } from '@/stores/lyrics'
import NowPlayingStageMobile from '@/components/now-playing/NowPlayingStageMobile.vue'
import NowPlayingStageDesktop from '@/components/now-playing/NowPlayingStageDesktop.vue'
import NowPlayingBackdrop from '@/components/now-playing/NowPlayingBackdrop.vue'
import NowPlayingVisualizer from '@/components/now-playing/NowPlayingVisualizer.vue'
import NowPlayingToolbar from '@/components/now-playing/NowPlayingToolbar.vue'
import type { NowPlayingPanel } from '@/components/now-playing/types'
import { radioFaviconRequest, type RadioFaviconRequest } from '@/services/connect/radio'
import { getLogLevel } from '@/services/connect/logLevel'
import { getArtistArt, nextBackground, rememberBackground } from '@/services/connect/fanart'
import { preloadImage } from '@/services/preloadImage'
import { useFanartStore } from '@/stores/fanart'
import type { RadioTitleEntry } from '@/services/connect/radioMetadata'
import VisualizerDebugOverlay from '@/components/player/VisualizerDebugOverlay.vue'
import type { VisualizerFrame } from '@/services/connect/types'
import { getAudioEngine } from '@/services/audioEngine'
import { extractDominantColor } from '@/services/colorExtractor'
import { visualizerBarColor } from '@/services/visualizerColor'
import { appAccent } from '@/services/appAccent'
import { accountScopedKey } from '@/services/accountKey'
import type { Song } from '@/types/library'

// Warm amber — the same signal color the app is named after (see main.ts's
// 'beacon' theme) — used whenever there's nothing to extract a color from
// yet (radio has no artwork, or extraction is still in flight/failed).
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
  components: {
    VisualizerDebugOverlay,
    NowPlayingStageMobile,
    NowPlayingStageDesktop,
    NowPlayingBackdrop,
    NowPlayingVisualizer,
    NowPlayingToolbar,
  },
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
  data() {
    return {
      // The flip-boundary slide — see onStageResized(). Unread by the
      // template, so writing them costs no re-render.
      stageObserver: null as ResizeObserver | null,
      wasFlipped: null as boolean | null,
      splitOffset: 0,
      endSlide: null as (() => void) | null,
      // Both belong to the debug button in the toolbar — see its own
      // comment. Off, and empty, for everyone who is not chasing something.
      debugEnabled: false,
      debugTitles: [] as RadioTitleEntry[],
      // "r, g, b" — kept as a CSS-ready string so the two computed styles
      // below don't each redo the same join().
      extractedColor: null as string | null,
      // <audio-visualizer>'s own 'debug-frame' event, forwarded straight
      // through to <visualizer-debug-overlay> — see that component's own
      // comment for why it's rendered here instead of inside
      // <audio-visualizer> itself.
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
      // Tracks the real DOM state (via the fullscreenchange listener below),
      // not just "did we ask for it" — the browser/OS can exit fullscreen
      // on its own (Esc key, an OS-level shortcut), and the button's
      // icon/title need to reflect that either way.
      isFullscreen: false,
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
    currentSong() {
      return this.playbackStore.currentSong
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
          song: this.currentSong,
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
          song: this.nextSong,
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
    // Not expected in practice (the web/Docker build is the only place
    // `compact` can even change live, by resizing the window across
    // MobileLayout's breakpoint — Electron never shows the mobile layout at
    // all) — but if it ever does happen mid-fullscreen, the button that
    // would let the user back out is the exact thing compact mode just hid.
    compact(isCompact: boolean) {
      if (isCompact && document.fullscreenElement === this.$refs.root) {
        void document.exitFullscreen()
      }
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
    // The whole app's accent follows the bars for as long as this view is on
    // screen: the artist background's own colour (see visualizerColor) takes
    // over the theme's primary, so buttons, the player bar and everything
    // else tint along with the picture. Reset on the way out (beforeUnmount) -
    // the colour belongs to Now Playing, not to the rest of the app.
    visualizerColor: {
      immediate: true,
      handler(color: string) {
        this.applyPrimary(color)
      },
    },
  },
  mounted() {
    document.addEventListener('fullscreenchange', this.onFullscreenChange)
    // Watches the stage rather than the window: the container query that
    // decides the flip is answered by this box, not by the viewport (a
    // sidebar opening changes one without the other).
    const stage = this.$refs.stage as HTMLElement | undefined
    if (stage) {
      this.stageObserver = new ResizeObserver(() => this.onStageResized())
      this.stageObserver.observe(stage)
    }

    // Best-effort, exactly as VisualizerDebugOverlay.vue does it: a failed
    // call just leaves the debug button away, which is the right outcome
    // for anyone who was not looking for it.
    getLogLevel()
      .then(({ level }) => {
        this.debugEnabled = level === 'DEBUG' || level === 'TRACE'
      })
      .catch(() => {})
  },
  beforeUnmount() {
    this.stageObserver?.disconnect()
    this.endSlide?.()
    document.removeEventListener('fullscreenchange', this.onFullscreenChange)
    // The borrowed accent goes back with the view - see the visualizerColor
    // watcher.
    this.applyPrimary(FALLBACK_COLOR)
    // Leaving the view (route change, logout, ...) shouldn't strand the
    // whole window in fullscreen with nothing controlling it anymore.
    if (document.fullscreenElement === this.$refs.root) void document.exitFullscreen()
  },
  methods: {
    /** Puts `color` - an "r, g, b" triplet, as visualizerColor returns it -
     * into the theme's primary slot, and mirrors it for the canvas
     * components that cannot read a CSS variable (the waveform). Going
     * through the theme object rather than the --v-theme-primary variable
     * directly is what lets Vuetify re-derive `on-primary` for it, so text
     * on a primary surface keeps its contrast. */
    applyPrimary(color: string): void {
      appAccent.value = color
      const theme = this.$vuetify.theme
      const colors = theme.themes[theme.name]?.colors
      if (colors) colors.primary = `rgb(${color})`
    },
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
    /** Slides the artwork column across the flip boundary instead of
     * letting it jump. `position` is not animatable, so the lyrics panel
     * enters the flex row at its full width in one frame and the centered
     * column lands ~80px away; this puts it back where it was and
     * transitions that away, the way TransitionGroup animates a move.
     *
     * The flip state is read off the card's computed `display` so the
     * container query in <style> stays the only place the boundary is
     * defined. */
    onStageResized(): void {
      // The card lives in whichever stage component is rendered, so it is
      // reached through the stage box rather than a template ref — see
      // .now-playing__stage below.
      const stage = this.$refs.stage as HTMLElement | undefined
      const card = stage?.querySelector<HTMLElement>('.now-playing__flip-card')
      const primary = stage?.querySelector<HTMLElement>('.now-playing__primary')
      if (!card || !primary) {
        this.wasFlipped = null
        this.splitOffset = 0
        return
      }
      const flipped = getComputedStyle(card).display !== 'contents'
      const crossed = this.wasFlipped !== null && flipped !== this.wasFlipped
      this.wasFlipped = flipped
      if (!flipped) this.splitOffset = this.measureSplitOffset(primary)
      if (!crossed || this.splitOffset <= 0) return
      // Only a crossing cancels a running slide. A drag keeps firing this
      // while one runs, and cancelling there is what made a fast drag snap:
      // the transform was cleared a frame after it went on.
      this.endSlide?.()
      this.slidePrimaryFrom(primary, ((flipped ? -1 : 1) * this.splitOffset) / 2, flipped)
    },
    /** How much room the lyrics panel takes out of the centred row: its own
     * width plus the gap before it. Half of that is how far the artwork
     * column moves when the panel enters or leaves the flow, which is the
     * jump the slide compensates.
     *
     * Measured rather than derived from the previous frame's position: a
     * fast drag moves the window a long way between two resize callbacks,
     * and the column's own travel over that distance would then be
     * mistaken for the crossing. It is read while the row is split and
     * kept for the crossing back, which cannot measure it - the panel is
     * out of the flow by then. */
    measureSplitOffset(primary: HTMLElement): number {
      const panel = (this.$refs.stage as HTMLElement).querySelector('.now-playing__lyrics')
      if (!panel) return 0
      return panel.getBoundingClientRect().right - primary.getBoundingClientRect().right
    },
    /** Inside the container query .now-playing__primary carries an explicit
     * rotateY(0deg) (see that rule for Chromium's backface check), and an
     * inline transform replaces the whole value, rotation included. */
    primaryTransform(flipped: boolean, dx = 0): string {
      const parts = [dx ? `translateX(${dx}px)` : '', flipped ? 'rotateY(0deg)' : '']
      return parts.filter(Boolean).join(' ') || 'none'
    },
    slidePrimaryFrom(primary: HTMLElement, dx: number, flipped: boolean): void {
      if (Math.abs(dx) < 2) return
      primary.style.transition = 'none'
      primary.style.transform = this.primaryTransform(flipped, dx)
      // Takes the start state before the transition is armed; without it
      // both writes land in the same frame with nothing to animate from.
      void primary.offsetWidth
      primary.style.transition = 'transform 0.45s ease'
      primary.style.transform = this.primaryTransform(flipped)
      const done = (): void => {
        primary.removeEventListener('transitionend', done)
        primary.style.transition = ''
        primary.style.transform = ''
        this.endSlide = null
      }
      // Also called by the next crossing and by beforeUnmount, so a slide
      // never outlives what it was measured against.
      this.endSlide = done
      primary.addEventListener('transitionend', done)
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
    // Requests fullscreen on this view's own root element, not
    // document.documentElement — the point is hiding the rest of the app
    // chrome (app-bar, sidebar, PlayerBar) around it, not just the
    // OS/browser window frame a document-level fullscreen would leave
    // everything else still visible underneath.
    async toggleFullscreen() {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen()
        } else {
          await (this.$refs.root as HTMLElement).requestFullscreen()
        }
      } catch (error) {
        // Rare in practice (this only ever runs from a direct click, which
        // is exactly the user-gesture context the Fullscreen API requires)
        // — a platform/permissions-policy refusal shouldn't be a silent
        // unhandled rejection, but isn't worth surfacing to the user over
        // either; the button's icon just won't have changed.
        console.error('[now-playing] Fullscreen request failed:', error)
      }
    },
    onFullscreenChange() {
      this.isFullscreen = document.fullscreenElement === this.$refs.root
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

<style scoped>
.now-playing {
  width: 100%;
  /* NOT height: 100% — Vuetify's own .v-main is `flex: 1 0 auto` (flex-
   * shrink: 0) inside .v-application__wrap, which itself is only
   * `min-height: 100dvh`, never a hard max. Nothing between here and the
   * actual <html> ever caps router-view's height against the viewport —
   * "100%" of an ancestor chain that's really "auto, whatever my own
   * content needs" isn't a cap at all, just height: auto by another name.
   * Computed directly from the real viewport instead, the same pattern
   * Vuetify's own docs use for "fill the space between the app-bar and
   * whatever's docked at the bottom" — --v-layout-top/--v-layout-bottom
   * are the exact live pixel heights Vuetify's layout system already
   * songs for every registered app-bar/footer (see composables/layout.js),
   * set as inherited CSS custom properties, not something this file has to
   * duplicate or guess. */
  /* svh, not dvh, plus a plain-vh line under it for engines that know
   * neither.
   *
   * `dvh` is only right if the browser subtracts its own chrome, and not
   * every one does: Orion on iOS reports 100dvh as though its bottom bar
   * (address field plus button row, some 200px) were not there, so this
   * box came out that much taller than the visible area and the page
   * scrolled by exactly that - artwork out of the top, a black band above
   * the tab bar. Safari made the same mistake, small enough to shrug at.
   *
   * `svh` is the smallest viewport height, the one with every dynamic
   * toolbar shown, so it cannot overflow: where a toolbar later hides, a
   * strip of unused space is left rather than the page growing past the
   * screen. That fixed Safari. Orion is unchanged by it - it gets svh
   * wrong the same way - and is deliberately left there: chasing it needs
   * the real height measured through visualViewport in JS, which is a lot
   * of machinery for one uncommon browser. On a desktop window nothing is
   * dynamic and all three units are the same number.
   *
   * Two declarations because an engine that knows neither drops the line
   * entirely and falls back to `auto`, which nothing in the chain above
   * caps - the page then grows to whatever the content needs. */
  height: calc(100vh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
  height: calc(100svh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
  position: relative;
  /* Grid, not flex — two rows, .now-playing__stage and
   * .now-playing__visualizer-row, sharing this element's (now definite,
   * see height above) height. minmax(0, 1fr) is grid's own "take whatever's
   * left, but you're allowed to shrink below your content's natural size"
   * — the exact thing flex needed a separate min-height: 0 escape hatch
   * for, here it's just how 1fr already behaves. auto for the visualizer
   * row sizes it to the visualizer's own content (128px when mounted,
   * collapses to 0 on its own when it isn't — no manual toggling needed).
   * justify-items: center centers both rows horizontally. */
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  justify-items: center;
  overflow: hidden;
  /* Opaque fallback behind the two layers below — matters for radio, where
   * the backdrop has no image to show. */
  background: #12141c;
}

/* Mirrors the toolbar's own corner placement (opposite side, so
 * the two never collide) — see VisualizerDebugOverlay's own comment for
 * why this lives here rather than inside <audio-visualizer>/the visualizer
 * row: this way it takes no layout space from the bars at all, in a corner
 * they don't reach into either. Applied straight to
 * <visualizer-debug-overlay>'s own root (class fallthrough) — that root is
 * itself v-if'd (nothing rendered, not just hidden, while there's no debug
 * frame to show), so there's no empty positioned element left over to
 * worry about eating clicks the rest of the time. */
.now-playing__visualizer-debug {
  position: absolute;
  bottom: 370px;
  left: 32px;
  z-index: 2;
}

/* Row 1 of .now-playing's grid (minmax(0, 1fr), see above) — takes up
 * exactly "whatever's left" after the visualizer row has taken its share,
 * shrinkable below its own content's natural size like any minmax(0, ...)
 * grid song. width/height: 100% is what turns this into the measurement
 * basis for the stage components' artSize cqh/cqw units via container-type:
 * size — a *real* available-space measurement, unlike vh/vw which had no
 * idea how much of the raw viewport the app-bar/PlayerBar/visualizer row had
 * already taken. */
.now-playing__stage {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  container-type: size;
  container-name: now-playing-stage;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

/* Mobile (see the `compact` prop) — same view, much less room to work with:
 * squeezed under MobileTransportControls.vue and the tab bar instead of the
 * near-full-viewport height this gets on desktop. Everything not overridden
 * here (backdrop, glow, lyrics-split, visualizer positioning) stays as-is.
 *
 * .now-playing.now-playing--compact (compound, not just the modifier class
 * alone) is deliberate — needs to outrank the base .now-playing rule's own
 * height regardless of source order, same reasoning as
 * .sheet-title-row button.btn-sheet-action elsewhere in this app. */
.now-playing.now-playing--compact {
  /* NOT the base rule's calc(100svh - ...) — that's the right height for
   * .now-playing when it's the *entire* routed view (desktop), but here
   * it's nested inside MobileNowPlayingView.vue's own grid, sharing that
   * same total viewport height with MobileTransportControls.vue below it.
   * Claiming the full viewport-minus-chrome amount for itself *too* made
   * it overflow its own grid cell there (.mobile-now-playing__art, sized
   * by minmax(0, 1fr) to *already* exclude the transport controls' own
   * share) — the excess got clipped by that cell's overflow: hidden, and
   * since this element's own internal grid lays out top-to-bottom (art
   * stage, then the visualizer row), the clipped part was the bottom: the
   * visualizer, pushed below the visible area entirely. 100% instead just
   * fills whatever height that already-correctly-sized grid cell gives it. */
  height: 100%;
}

.now-playing--compact .now-playing__visualizer-debug {
  /* bottom: auto is load-bearing, not tidying: the desktop rule above sets
   * bottom: 180px, and an absolutely positioned box with height: auto and
   * *both* offsets given gets stretched to span between them. Adding top
   * alone turned this small badge into a tall dark column of its own
   * translucent background, straight down the artwork. */
  top: 8px;
  bottom: auto;
  left: 8px;
}
</style>
