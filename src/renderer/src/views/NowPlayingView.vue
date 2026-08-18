<template>
  <div class="now-playing" :class="{ 'now-playing--compact': compact }">
    <!-- Full-bleed blurred artwork behind everything — same backdrop
     - language as DetailHeader.vue's hero cards (blur + scrim over the
     - item's own art). Two stacked layers so a song change crossfades
     - between cover arts — see backdropLayers' comment. -->
    <div
      v-for="(url, i) in backdropLayers"
      :key="i"
      class="now-playing__backdrop"
      :class="{ 'now-playing__backdrop--active': i === activeBackdropLayer }"
      :style="url ? { backgroundImage: `url(${url})` } : {}"
    />
    <div class="now-playing__scrim" :style="ambientStyle" />

    <div v-if="hasPlayable" class="now-playing__toolbar">
      <v-btn
        :icon="showVisualizer ? 'mdi-equalizer' : 'mdi-equalizer-outline'"
        variant="text"
        :title="$t('nowPlaying.toggleVisualizer')"
        @click="showVisualizer = !showVisualizer"
      />
    </div>

    <!-- The container-query host — see artSize's own comment. .now-playing's
     - own grid (see <style>, grid-template-rows: minmax(0, 1fr) auto) is
     - what makes this take up exactly whatever's left after the visualizer
     - row, and container-type: size is what lets artSize/.now-playing__content--split
     - etc. measure *that* real, already-chrome-aware space (cqh/cqw)
     - instead of the raw viewport (vh/vw), which had no idea how much of
     - itself the app-bar/PlayerBar/visualizer row had already taken.
     - A separate element from .now-playing__content on purpose — an
     - element can't size *itself* using its own cqh/cqw units (circular,
     - the browser just ignores it), so this one only ever gets plain flex
     - sizing, and .now-playing__content (and everything inside it)
     - measures against this ancestor instead. -->
    <div class="now-playing__stage">
      <div
        class="now-playing__content"
        :class="{ 'now-playing__content--split': hasPlayable && showLyrics }"
      >
        <template v-if="hasPlayable">
          <div class="now-playing__primary">
            <div class="now-playing__art-wrap">
              <div class="now-playing__art-glow" :style="{ background: glowColor }" />
              <cover-art
                v-if="currentSong"
                :cover-art-id="currentSong.coverArtId"
                :size="artSize"
                class="cover-shadow"
              />
              <!-- No cover-shadow/card background for a transparent icon
               - (see radioIconIsTransparent) — a real card treatment
               - around a logo that's just floating on transparency looks
               - like a broken image (this app's own dark background
               - showing through the "card" as a faint muddy tint) rather
               - than a clean logo. -->
              <cover-art
                v-else
                :image-url="radioFaviconSrc"
                :size="artSize"
                fallback-icon="mdi-radio"
                :class="radioIconIsTransparent ? 'radio-cover-art--transparent' : 'cover-shadow'"
              />
            </div>

            <div class="now-playing__info">
              <div class="eyebrow-label mb-2">{{ eyebrow }}</div>
              <h1 class="detail-title now-playing__title mb-2">
                {{ currentSong?.title ?? playbackStore.radioStation?.name }}
              </h1>
              <router-link
                v-if="currentSong"
                :to="`/artists/${currentSong.artistId}`"
                class="text-h6 text-medium-emphasis now-playing__artist-link mb-2"
              >
                {{ currentSong.artist }}
              </router-link>
              <div v-else class="text-h6 text-medium-emphasis mb-2" />
              <router-link
                v-if="currentSong"
                :to="`/albums/${currentSong.albumId}`"
                class="text-body-2 text-medium-emphasis now-playing__album-link"
              >
                {{ currentSong.album }}
              </router-link>
            </div>
          </div>

          <transition name="now-playing-lyrics">
            <lyrics-panel v-if="showLyrics" variant="immersive" class="now-playing__lyrics" />
          </transition>
        </template>

        <span v-else class="text-medium-emphasis">{{ $t('nowPlaying.nothingPlaying') }}</span>
      </div>
    </div>

    <!-- Real audio-reactive either way: a local Web Audio analyser during
     - local playback, or the backend's own real-time analysis (see
     - connect/core/audio_analysis.py) while casting to a target it can
     - actually run against — see visualizerAvailable for which can't.
     - Always in the DOM (unlike <audio-visualizer> itself, still v-if'd
     - below) so its height can *transition* between 0 and its real height
     - instead of the row just appearing/disappearing — .now-playing__stage
     - above is a grid `auto` sibling, so animating this row's height is
     - what makes the artwork's cqh-driven size (see artSize) resize
     - smoothly along with it instead of snapping the instant this mounts/
     - unmounts, which is what a bare v-if here used to do. <audio-visualizer>
     - itself stays mounted a moment past visualizerActive going false so its
     - `active` prop can let the bars settle to 0 first instead of just
     - vanishing — see the visualizerActive watcher; that settle plays out
     - over the same VISUALIZER_HIDE_DELAY_MS this row's own height
     - transition takes, so both finish together. -->
    <div
      class="now-playing__visualizer-row"
      :class="{ 'now-playing__visualizer-row--visible': visualizerMounted }"
    >
      <audio-visualizer v-if="visualizerMounted" :active="visualizerActive" />
    </div>
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import { useLyricsStore } from '@/stores/lyrics'
import { useConnectStore } from '@/stores/connect'
import { useAuthStore } from '@/stores/auth'
import { radioFaviconUrl } from '@/services/connect/radio'
import CoverArt from '@/components/library/CoverArt.vue'
import LyricsPanel from '@/components/lyrics/LyricsPanel.vue'
import AudioVisualizer from '@/components/player/AudioVisualizer.vue'
import { extractDominantColor } from '@/services/colorExtractor'
import { hasTransparency } from '@/services/imageTransparency'

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
    return localStorage.getItem(SHOW_VISUALIZER_KEY) !== 'false'
  } catch {
    return true
  }
}

// How long <audio-visualizer> stays mounted (with active=false) after
// visualizerActive goes false — long enough for its own smoothing to
// visibly settle every bar to 0 before it's actually removed.
const VISUALIZER_HIDE_DELAY_MS = 400

export default {
  name: 'NowPlayingView',
  components: { CoverArt, LyricsPanel, AudioVisualizer },
  props: {
    // Set by MobileNowPlayingView.vue — this view's own sizing (artSize
    // below, plus the .now-playing--compact overrides in <style>) assumes
    // the near-full-viewport height it gets on desktop (between the app-bar
    // and PlayerBar.vue); squeezed under a mobile transport-controls block
    // and tab bar instead, that same sizing overflowed badly. Everything
    // else about this view (backdrop, glow, lyrics-split, visualizer) stays
    // shared — only sizing changes.
    compact: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      // "r, g, b" — kept as a CSS-ready string so the two computed styles
      // below don't each redo the same join().
      extractedColor: null as string | null,
      // Set by the radioFaviconSrc watcher below, once hasTransparency() has
      // actually sampled the image — false (normal card treatment) until
      // then, so there's no flash of the transparent-icon styling before
      // the icon itself has even loaded.
      radioIconIsTransparent: false,
      // Two stacked layers so a song change can crossfade between cover
      // arts instead of popping — a plain CSS `transition` on
      // background-image doesn't actually interpolate between two url()s
      // (there's nothing for the browser to blend between two arbitrary
      // images), it just swaps at the halfway point, which reads as a hard
      // cut despite the transition being there. Alternating which layer is
      // "active" (opacity: 1, see the template/style below) and setting the
      // new image on the other one lets a plain opacity transition do the
      // actual crossfade instead. See setBackdrop().
      backdropLayers: [null, null] as (string | null)[],
      activeBackdropLayer: 0,
      showVisualizer: readShowVisualizer(),
      // Whether <audio-visualizer> is actually in the DOM — trails
      // visualizerActive by visualizerHideDelayMs on the way down so its
      // fall-to-0 animation (see its `active` prop) has time to play
      // before it's removed; see the visualizerActive watcher below.
      visualizerMounted: false,
      visualizerHideTimer: null as ReturnType<typeof setTimeout> | null,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    connectStore() {
      return useConnectStore()
    },
    currentSong() {
      return this.playbackStore.currentSong
    },
    hasPlayable() {
      return this.currentSong != null || this.playbackStore.radioStation != null
    },
    // cqh/cqw (container query units), not vh/vw — .now-playing__stage is a
    // `container-type: size` host (see <style>) sized by .now-playing's own
    // grid (minmax(0, 1fr), after the app-bar/PlayerBar outside this
    // component and the visualizer row below it have already taken their
    // share), so cqh/cqw here measure the space actually left for the
    // artwork specifically. vh/vw measure the *raw* viewport instead, with
    // no idea how much of it any of that chrome eats — on a short window
    // that read as "too big, has to scroll to see the visualizer"; on a
    // 4K one, capped at a fixed 700px ceiling that never grew with all the
    // extra room actually available, it read as "lost". Both are just this
    // same wrong-measurement bug at opposite ends.
    //
    // Still clamped (a floor so it doesn't shrink to nothing on a tiny
    // container, a ceiling — now much higher — so it doesn't blow up
    // absurdly large on a huge one) and still min()'d against both a
    // height and a width fraction, same reasoning as before: a *short*
    // container and a *narrow* one are both real ways to run out of room,
    // independently.
    artSize(): string {
      return this.compact
        ? 'clamp(120px, min(55cqh, 60cqw), 320px)'
        : 'clamp(180px, min(60cqh, 45cqw), 900px)'
    },
    // Backed by the same store flag PlayerBar's lyrics button drives
    // (playbackStore.lyricsDrawerOpen) instead of its own local state —
    // there used to be two independent lyrics toggles (this view's own
    // toolbar button, and PlayerBar's), which was confusing since they
    // controlled two different-looking presentations (this view's inline
    // split panel vs. LyricsDrawer.vue's slide-out) of the same lyrics.
    // Now there's one flag and one button (PlayerBar's, always visible —
    // see DefaultLayout.vue); this view just renders it inline instead of
    // as a drawer while it's the active route (see DefaultLayout.vue's own
    // now-playing check, which keeps LyricsDrawer closed here so the two
    // presentations don't both show at once). The setter is still needed
    // for the currentSong watcher below, which turns lyrics back off when
    // switching to radio.
    showLyrics: {
      get(): boolean {
        return this.playbackStore.lyricsDrawerOpen
      },
      set(value: boolean) {
        this.playbackStore.lyricsDrawerOpen = value
      },
    },
    // AirPlay downloads a whole song into memory *ahead* of pushing it to
    // the device (see connect/delivery/airplay.py), and radio's raw
    // station URL bypasses connect's streaming pipeline entirely — neither
    // has real audio data for the backend to analyze (see
    // connect/core/audio_analysis.py's should_analyze()), so there's
    // nothing honest to show for them rather than a fake animation.
    visualizerAvailable() {
      if (!this.playbackStore.isCasting) return true
      if (!this.currentSong) return false // casting radio
      return this.connectStore.activeTargets.some((target) => target.type !== 'airplay')
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
    coverArtUrl(): string | null {
      const id = this.currentSong?.coverArtId
      return id ? useLibraryStore().client().coverArtUrl(id, 400) : null
    },
    // The biggest single spot in the whole app for one of these — 512 asks
    // for whatever's largest a station's homepage actually declares (see
    // routes/radio.py's _select()), same reasoning as PlayerBar's own
    // radioFaviconSrc but with more headroom given how large this renders.
    radioFaviconSrc(): string | null {
      const homePageUrl = this.playbackStore.radioStation?.homePageUrl
      if (!homePageUrl) return null
      const auth = useAuthStore()
      return radioFaviconUrl(auth.apiUrl, auth.connectToken, homePageUrl, 512)
    },
    colorTriplet(): string {
      return this.extractedColor ?? FALLBACK_COLOR
    },
    // A soft, wide wash filling the whole screen — the "room" the artwork
    // sits in reacts to whatever's playing, the same idea as the lighthouse
    // in the app's own name: the light changes color with what it's
    // guiding you through. Sits *over* the backdrop above as a semi-
    // transparent tint (matching DetailHeader's own 0.55 scrim opacity),
    // not an opaque fill — the blurred artwork needs to still show through.
    ambientStyle() {
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
        this.setBackdrop(url)
      },
    },
    radioFaviconSrc: {
      immediate: true,
      async handler(url: string | null) {
        this.radioIconIsTransparent = false
        if (!url) return
        const transparent = await hasTransparency(url)
        // The station may have changed again while this sampled the image
        // — don't let a stale result overwrite whatever's current now.
        if (url === this.radioFaviconSrc) this.radioIconIsTransparent = transparent
      },
    },
    // Loads on entering lyrics mode, and again on every song change while
    // already in it — see LyricsDrawer.vue's identical pair of watchers for
    // why this is consumer-triggered rather than eager in the store itself.
    showLyrics(show: boolean) {
      if (show && this.currentSong) useLyricsStore().ensureLoaded(this.currentSong)
    },
    currentSong(song) {
      // Radio has no lyrics concept — fall back to the normal artwork view
      // instead of being stuck showing lyrics for nothing.
      if (!song) {
        this.showLyrics = false
        return
      }
      if (this.showLyrics) useLyricsStore().ensureLoaded(song)
    },
    showVisualizer(value: boolean) {
      try {
        localStorage.setItem(SHOW_VISUALIZER_KEY, String(value))
      } catch {
        // Non-critical — worst case the preference doesn't survive to the
        // next launch.
      }
    },
    // Mount instantly on the way up; on the way down, keep it mounted
    // (with active=false) for VISUALIZER_HIDE_DELAY_MS so AudioVisualizer's
    // own smoothing can settle every bar to 0 first — see its `active`
    // prop. Without this the whole element (and whatever it was mid-way
    // through animating) would just vanish instantly instead.
    visualizerActive: {
      immediate: true,
      handler(active: boolean) {
        if (this.visualizerHideTimer) {
          clearTimeout(this.visualizerHideTimer)
          this.visualizerHideTimer = null
        }
        if (active) {
          this.visualizerMounted = true
        } else if (this.visualizerMounted) {
          this.visualizerHideTimer = setTimeout(() => {
            this.visualizerMounted = false
          }, VISUALIZER_HIDE_DELAY_MS)
        }
      },
    },
  },
  beforeUnmount() {
    if (this.visualizerHideTimer) clearTimeout(this.visualizerHideTimer)
  },
  methods: {
    async loadColor(url: string) {
      const color = await extractDominantColor(url)
      // The song may have changed again while the image was loading —
      // don't let a stale extraction overwrite whatever's current now.
      if (url !== this.coverArtUrl) return
      this.extractedColor = color ? color.join(', ') : null
    },
    // Puts `url` on the currently-*inactive* layer and flips which one is
    // active — the opacity transition on now-playing__backdrop--active (see
    // <style> below) is what actually crossfades from whatever the other
    // layer still shows to this one. See backdropLayers' comment for why
    // this exists instead of just binding the image straight to a single
    // element's style.
    setBackdrop(url: string | null) {
      const next = this.activeBackdropLayer === 0 ? 1 : 0
      this.backdropLayers[next] = url
      this.activeBackdropLayer = next
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
  height: calc(100dvh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
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
   * .now-playing__backdrop has no image to show. */
  background: #12141c;
}

/* Full-bleed blurred artwork — same technique as DetailHeader.vue's
 * .detail-header__backdrop (blur + oversized + scaled so the blur radius
 * never reveals a hard edge at the viewport bounds). */
.now-playing__backdrop {
  position: absolute;
  inset: -60px;
  background-size: cover;
  background-position: center;
  filter: blur(50px) saturate(1.3) brightness(0.5);
  transform: scale(1.15);
  /* Two stacked instances of this (see backdropLayers), only one of which
   * is --active (opacity: 1) at a time — this opacity transition is what
   * actually crossfades between them on a song change. A plain
   * `transition: background-image` on a single element (the previous
   * approach) doesn't work: there's no browser-defined interpolation
   * between two url()s, so it just swaps at the halfway point instead of
   * blending. */
  opacity: 0;
  transition: opacity 0.6s ease;
}

.now-playing__backdrop--active {
  opacity: 1;
}

.now-playing__scrim {
  position: absolute;
  inset: 0;
  /* Ambient color is set inline (:style) since it depends on the song;
   * the transition is what makes it change *into* the new color smoothly
   * on a song change instead of snapping. */
  transition: background 1.2s ease;
}

.now-playing__toolbar {
  position: absolute;
  top: 24px;
  right: 24px;
  z-index: 2;
  display: flex;
  gap: 4px;
}

/* Row 1 of .now-playing's grid (minmax(0, 1fr), see above) — takes up
 * exactly "whatever's left" after the visualizer row has taken its share,
 * shrinkable below its own content's natural size like any minmax(0, ...)
 * grid song. width/height: 100% is what turns this into the measurement
 * basis for artSize's cqh/cqw units below via container-type: size — a
 * *real* available-space measurement, unlike vh/vw which had no idea how
 * much of the raw viewport the app-bar/PlayerBar/visualizer row had
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

/* Always a row (even with just one child, .now-playing__primary, when
 * lyrics are hidden) so toggling lyrics never flips flex-direction itself
 * — that can't be transitioned. Instead .now-playing__lyrics animates its
 * own width from 0 up, and since this row stays centered throughout, the
 * artwork column drifts to the side on its own as the row grows to fit
 * both — see .now-playing__content--split's much wider cap below, which is
 * what actually gives it room to do that instead of also having to shrink
 * the artwork itself (see the cover-art size prop above, now fixed
 * regardless of showLyrics). */
.now-playing__content {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 32px;
  max-width: 640px;
  gap: 0;
  transition:
    gap 0.45s ease,
    max-width 0.45s ease;
}

.now-playing__content--split {
  max-width: 1800px;
  width: 96cqw;
  gap: 40px;
  /* Safety net for narrow containers: .now-playing__primary and
   * .now-playing__lyrics are both flex-shrink: 0 by design (see each's own
   * comment) — their combined natural width can still exceed this row's
   * own box on a narrow enough container despite artSize's own cqw-aware
   * clamp above. Wrapping to two centered rows there beats the alternative
   * (this row's content silently bleeding past .now-playing__stage's own
   * overflow: hidden, clipping straight through the middle of the artwork
   * or the lyrics text) — rare in practice once artSize is already
   * width-aware, but a real fallback rather than an unhandled edge case. */
  flex-wrap: wrap;
}

.now-playing__primary {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  flex-shrink: 0;
}

/* Tall, bounded reading area — LyricsPanel scrolls within whatever height
 * it's given. A fixed target width (not flex: 1) so the enter/leave
 * transition below has a concrete value to animate from/to; overflow
 * hidden clips its contents while that width is mid-animation. cqw/cqh
 * (not vw/vh) for the same reason as artSize above — measured against the
 * real available stage, not the raw viewport. */
.now-playing__lyrics {
  flex-shrink: 0;
  width: min(38cqw, 560px);
  height: 85cqh;
  overflow: hidden;
}

.now-playing-lyrics-enter-active,
.now-playing-lyrics-leave-active {
  transition:
    width 0.45s ease,
    opacity 0.35s ease;
}

.now-playing-lyrics-enter-from,
.now-playing-lyrics-leave-to {
  width: 0;
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .now-playing__content,
  .now-playing-lyrics-enter-active,
  .now-playing-lyrics-leave-active,
  .now-playing__visualizer-row {
    transition: none;
  }
}

/* Padding lives here, not on the canvas — a canvas's own CSS padding
 * would desync from its drawing buffer (sized off getBoundingClientRect,
 * which includes padding), pushing the bars off-center from where the
 * bitmap actually paints. A real flex row (fixed height, see .now-playing's
 * own flex-direction: column) rather than the absolutely-positioned overlay
 * this used to be — .now-playing__stage shrinks to make room for it through
 * normal flex arithmetic, so nothing here needs a guessed padding-bottom on
 * the content above it to avoid overlapping. */
.now-playing__visualizer-row {
  position: relative;
  z-index: 1;
  /* Row 2 of .now-playing's grid is `auto` (see above) — sizes to this
   * element's own actual height, which is what makes the transition below
   * animate .now-playing__stage's own share of the grid smoothly instead of
   * snapping. 0 at rest; .now-playing__visualizer-row--visible (toggled
   * alongside visualizerMounted, see the template) sets the real height. */
  height: 0;
  width: 100%;
  padding: 0 5px;
  margin-bottom: -1px;
  pointer-events: none;
  overflow: hidden;
  transition: height 0.4s ease;
}

.now-playing__visualizer-row--visible {
  height: 128px;
}

.now-playing__art-wrap {
  position: relative;
  margin-bottom: 40px;
}

.now-playing__art-glow {
  position: absolute;
  inset: -70px;
  border-radius: 50%;
  filter: blur(60px);
  transition: background 1.2s ease;
  z-index: 0;
}

.now-playing__art-wrap :deep(.cover-art) {
  position: relative;
  z-index: 1;
}

/* Applied instead of cover-shadow once hasTransparency()
 * (services/imageTransparency.ts) has actually sampled the loaded favicon
 * and found it meaningfully transparent — drops CoverArt.vue's own default
 * card background (a faint white tint meant for genuinely art-less
 * placeholders) too, so a logo that's just floating on transparency shows
 * as exactly that instead of getting boxed in a card whose background
 * shows through the transparent parts as a muddy tint, with a drop shadow
 * around an edge that was never actually there.
 *
 * .radio-cover-art--transparent.cover-art (compound, not just the one
 * class) is deliberate — CoverArt.vue's own scoped background rule targets
 * .cover-art alone, so at equal specificity the one that happens to be
 * later in the built CSS wins, not necessarily this one. Matching both
 * classes outranks it regardless of build order. */
.radio-cover-art--transparent.cover-art {
  background: transparent;
}

.now-playing__info {
  /* .now-playing__primary is flex-shrink: 0 (deliberately — it keeps its
   * own natural size while the lyrics panel grows/shrinks next to it, see
   * .now-playing__content--split), which also means it never shrinks *its
   * own* content down to fit either — an unbroken long title/artist name
   * would otherwise just keep the whole row growing past
   * .now-playing__content's max-width instead of wrapping. Capping this to
   * the artwork's own width (see the artSize computed the cover-art's own
   * :size is bound to — kept in sync with it here since a plain CSS value
   * can't read a component's computed prop) gives long text something
   * concrete to actually wrap against. */
  max-width: min(clamp(180px, min(60cqh, 45cqw), 900px), 50cqw);
}

/* Scoped to .now-playing__info, not the bare global class — .eyebrow-label
 * is used all over the app (DetailHeader.vue, HomeView.vue's hero, ...)
 * with its own fixed size; this only overrides it here, and only for
 * responsive sizing (letter-spacing/weight/color stay whatever the global
 * class already sets). */
.now-playing__info .eyebrow-label {
  font-size: clamp(0.65rem, min(1.6cqw, 2cqh), 0.85rem);
}

/* cqw/cqh (see artSize's own comment for the underlying mechanism) — a
 * fixed 2.5rem used to look proportionally huge next to a small, correctly-
 * shrunk container (wrapping to 3-4 lines, see the screenshots this was
 * reported against) and proportionally tiny on a large one, since it never
 * scaled with the same container the artwork already does. min() against
 * both a width and a height fraction so a *short* container shrinks text
 * just as much as a *narrow* one does. */
.now-playing__title {
  font-size: clamp(1.1rem, min(2cqw, 8cqh), 2.75rem);
  line-height: 1.15;
  overflow-wrap: break-word;
}

/* .now-playing__info .now-playing__artist-link (compound), not the class
 * alone — Vuetify's own .text-h6 utility (also on this element, see the
 * template) is a single class at the same specificity, so without a
 * compound selector to outrank it, whichever of the two happens to be
 * later in the built stylesheet wins, not necessarily this one. */
.now-playing__info .now-playing__artist-link {
  font-size: clamp(0.9rem, min(3cqw, 4cqh), 1.5rem);
  /* Block, not the anchor's default inline — inline elements ignore
   * vertical margin (mb-2 here would otherwise silently do nothing) and
   * this also keeps the centered text-align behaving exactly like the
   * plain <div> this replaced. */
  display: block;
  text-decoration: none;
  overflow-wrap: break-word;
}

.now-playing__info .now-playing__album-link {
  font-size: clamp(0.75rem, min(2.2cqw, 3cqh), 1rem);
  text-decoration: none;
  overflow-wrap: break-word;
}

.now-playing__artist-link:hover,
.now-playing__album-link:hover {
  color: rgb(var(--v-theme-primary));
}

/* Mobile (see the `compact` prop) — same view, much less room to work with:
 * squeezed under MobileTransportControls.vue and the tab bar instead of the
 * near-full-viewport height this gets on desktop. Everything not overridden
 * here (backdrop, glow, lyrics-split, visualizer positioning) stays as-is.
 *
 * .now-playing.now-playing--compact (compound, not just the modifier class
 * alone) is deliberate — needs to outrank the base .now-playing rule's own
 * height regardless of source order, same reasoning as
 * .sheet-footer button.btn-sheet-action elsewhere in this app. */
.now-playing.now-playing--compact {
  /* NOT the base rule's calc(100dvh - ...) — that's the right height for
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

.now-playing--compact .now-playing__content {
  padding: 12px 16px;
  max-width: 100%;
}

.now-playing--compact .now-playing__art-wrap {
  margin-bottom: 16px;
}

.now-playing--compact .now-playing__info {
  max-width: 88cqw;
}

.now-playing--compact .now-playing__toolbar {
  top: 8px;
  right: 8px;
}

.now-playing--compact .now-playing__visualizer-row--visible {
  height: 64px;
}
</style>
