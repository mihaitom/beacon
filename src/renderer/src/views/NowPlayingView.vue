<template>
  <div ref="root" class="now-playing" :class="{ 'now-playing--compact': compact }">
    <!-- Full-bleed blurred artwork behind everything — same backdrop
     - language as DetailHeader.vue's hero cards (blur + scrim over the
     - item's own art). Two stacked layers so a song change crossfades
     - between cover arts — see backdropLayers' comment. -->
    <div
      v-for="(url, i) in backdrop.urls"
      :key="i"
      class="now-playing__backdrop"
      :class="{ 'now-playing__backdrop--active': i === backdrop.active }"
      :style="url ? { backgroundImage: `url(${url})` } : {}"
    />
    <div class="now-playing__scrim" :style="ambientStyle" />

    <!-- density="comfortable" on every button below — matches PlayerBar.vue's
     - own toolbar icons app-wide; left implicit (Vuetify's larger default
     - density) before, these rendered visibly bigger than every other icon
     - button in the app.
     -
     - Amber (color="primary") means "this is on", for every toggle here and
     - everywhere else in the app: PlayerToolbar.vue's lyrics/queue/autoplay/
     - cast buttons, CenterControls.vue's shuffle/repeat,
     - MobileTransportControls.vue's own copies, and the phone remote's
     - .active rule (connect/static/remote/app.css). These four used to each
     - say it differently — one colored, two swapping between an outline and
     - a filled icon, one saying nothing at all — so "is the visualizer on?"
     - read differently here than the identical question does two elements
     - away in the player bar. An icon still swaps where it describes what
     - the *click* does (fullscreen vs. exit fullscreen), never where it's
     - only restating the on/off state the color already carries. -->
    <div v-if="hasPlayable" class="now-playing__toolbar">
      <!-- PlayerBar.vue's own lyrics button (the normal way to reach this
       - on desktop) is outside .now-playing entirely, so fullscreen — which
       - only ever shows this element's own subtree, see toggleFullscreen()'s
       - comment — hides it along with the rest of the app chrome. Compact
       - mode has no PlayerBar equivalent at all (MobileTransportControls.vue
       - has no lyrics button — no side-by-side split there to reach it from
       - either, see the flip-card container query below), so this is the
       - *only* way to reach lyrics on mobile, not just a fullscreen
       - stand-in. Neither condition applies on desktop outside fullscreen,
       - where PlayerBar's own button already covers it — no redundant
       - second lyrics button there. -->
      <v-btn
        v-if="currentSong && (compact || isFullscreen)"
        icon="mdi-script-text-outline"
        :color="playbackStore.lyricsDrawerOpen ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('lyrics.title')"
        @click="playbackStore.toggleLyricsDrawer()"
      />
      <!-- Same reasoning as the lyrics button just above — PlayerBar.vue's
       - own Autoplay button (next to Queue) is outside .now-playing
       - entirely, so it's unreachable in fullscreen and doesn't exist at
       - all on mobile (MobileTransportControls.vue has no equivalent
       - slot), making this the only way to reach it in both cases. Not
       - shown outside fullscreen on desktop, where PlayerBar's own button
       - already covers it. -->
      <v-btn
        v-if="(compact || isFullscreen) && authStore.capabilities.songRadio"
        icon="mdi-infinity"
        :color="autoplayStore.enabled ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('player.autoplay')"
        @click="autoplayStore.setEnabled(!autoplayStore.enabled)"
      />
      <v-btn
        icon="mdi-equalizer"
        :color="showVisualizer ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('nowPlaying.toggleVisualizer')"
        @click="showVisualizer = !showVisualizer"
      />
      <!-- Not a mobile feature — MobileTransportControls.vue/the tab bar
       - already own the phone's actual full screen; hiding *that* app
       - chrome behind the Fullscreen API here wouldn't gain anything and
       - isn't what "fullscreen" reads as on a phone anyway. -->
      <v-btn
        v-if="!compact"
        :icon="isFullscreen ? 'mdi-fullscreen-exit' : 'mdi-fullscreen'"
        :color="isFullscreen ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('nowPlaying.toggleFullscreen')"
        @click="toggleFullscreen"
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
          <!-- display: contents outside the portrait container query (see
           - .now-playing__flip-card in <style>) — .now-playing__primary and
           - the lyrics panel behave as direct flex children of
           - .now-playing__content--split there, identical to before this
           - wrapper existed. Only on a portrait/narrow-aspect stage does it
           - become a real, positioned box: the "card" a 3D flip rotates,
           - with the artwork+info as its front face and lyrics absolutely
           - positioned as the back one — see that rule's own comment for
           - why a flip instead of the side-by-side split's flex-wrap
           - fallback there. -->
          <div class="now-playing__flip-card">
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
              <lyrics-panel
                v-if="showLyrics"
                variant="immersive"
                :mobile="compact"
                class="now-playing__lyrics"
              />
            </transition>
          </div>
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
import { createBackdropLayers, showBackdrop } from '@/services/crossfadeBackdrop'
import { useLyricsStore } from '@/stores/lyrics'
import { useConnectStore } from '@/stores/connect'
import { useAuthStore } from '@/stores/auth'
import { useAutoplayStore } from '@/stores/autoplay'
import { radioFaviconUrl } from '@/services/connect/radio'
import CoverArt from '@/components/library/CoverArt.vue'
import LyricsPanel from '@/components/lyrics/LyricsPanel.vue'
import AudioVisualizer from '@/components/player/AudioVisualizer.vue'
import { extractDominantColor } from '@/services/colorExtractor'
import { hasTransparency } from '@/services/imageTransparency'
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
      // Two stacked layers, only one shown at a time, so a song change
      // crossfades between cover arts instead of popping — see
      // services/crossfadeBackdrop.ts for why one element can't do this.
      backdrop: createBackdropLayers(),
      showVisualizer: readShowVisualizer(),
      // Whether <audio-visualizer> is actually in the DOM — trails
      // visualizerActive by visualizerHideDelayMs on the way down so its
      // fall-to-0 animation (see its `active` prop) has time to play
      // before it's removed; see the visualizerActive watcher below.
      visualizerMounted: false,
      visualizerHideTimer: null as ReturnType<typeof setTimeout> | null,
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
    connectStore() {
      return useConnectStore()
    },
    authStore() {
      return useAuthStore()
    },
    autoplayStore() {
      return useAutoplayStore()
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
        : 'clamp(180px, min(70cqh, 50cqw), 900px)'
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
        showBackdrop(this.backdrop, url)
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
        // Radio has no lyrics concept — fall back to the normal artwork
        // view instead of being stuck showing lyrics for nothing.
        if (!song) {
          this.showLyrics = false
          return
        }
        useLyricsStore().ensureLoaded(song)
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
  mounted() {
    document.addEventListener('fullscreenchange', this.onFullscreenChange)
  },
  beforeUnmount() {
    if (this.visualizerHideTimer) clearTimeout(this.visualizerHideTimer)
    document.removeEventListener('fullscreenchange', this.onFullscreenChange)
    // Leaving the view (route change, logout, ...) shouldn't strand the
    // whole window in fullscreen with nothing controlling it anymore.
    if (document.fullscreenElement === this.$refs.root) void document.exitFullscreen()
  },
  methods: {
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
  /* Two stacked instances of this, only one of which is --active
   * (opacity: 1) at a time — this opacity transition is what actually
   * crossfades between them on a song change (see
   * services/crossfadeBackdrop.ts). Same 0.6s as DetailHeader.vue and
   * HeroBand.vue, so every backdrop in the app fades at one speed. */
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
  /* Raised alongside artSize/.now-playing__info's own widescreen bump above
   * — .now-playing__primary is flex-shrink: 0, so on a screen where the
   * artwork now actually reaches close to artSize's 900px ceiling, the old
   * flat 640px here undersold what this box needed to comfortably contain
   * before overflowing it. */
  max-width: 1000px;
  gap: 0;
  transition:
    gap 0.45s ease,
    max-width 0.45s ease;
}

.now-playing__content--split {
  max-width: 1800px;
  width: 96cqw;
  /* Flat 40px read as cramped once the artwork itself started scaling up
   * more on wide monitors (see artSize's own widescreen bump) — grows with
   * the stage's own width instead, same cqw-driven approach as everything
   * else here, floor unchanged from the original fixed value so narrow
   * containers (already handled by the flex-wrap safety net below) don't
   * shift at all. */
  gap: clamp(40px, 6cqw, 120px);
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

/* Transparent to layout by default — see the template's own comment on
 * this element for what it becomes under the portrait container query
 * below. */
.now-playing__flip-card {
  display: contents;
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

/* Not enough width for artwork and lyrics to sit side by side the way
 * .now-playing__content--split's flex-wrap fallback above otherwise
 * handles it (stacking them into two rows, still both visible/competing
 * for the same limited width). Past this point, flip the artwork+info card
 * over like turning it to its back instead — lyrics take over the exact
 * box the artwork just occupied, rather than fighting it for space.
 *
 * Two conditions, because "does it still fit" genuinely depends on both
 * the container's shape *and* its width — the artwork is
 * min(70cqh, 50cqw) (see artSize), so a tall container sizes it off the
 * width and a flat one off the height, and those two regimes run out of
 * room at completely different places:
 *
 *  - max-aspect-ratio: 4/5 — portrait, including every phone. The original
 *    (and only) condition this block had.
 *  - max-width: 1560px and not flatter than 3/2 — where the artwork is
 *    width-driven, side by side only actually fits from ~1560px up:
 *    artwork (50cqw) + gap (6cqw) + lyrics (38cqw) is 94% of a row that
 *    only ever gets 96cqw minus 64px of padding, so the three grow almost
 *    exactly as fast as the room for them. Measured, not derived on paper
 *    — see NowPlayingView.layout.browser.test.ts, which pins both sides of
 *    this boundary. A flatter container (a short, wide window) caps the
 *    artwork at 70cqh well before that and keeps fitting comfortably,
 *    which is what the aspect-ratio half of the condition preserves;
 *    without it, a 1500x900 window would flip despite having room to
 *    spare.
 *
 * Before this, aspect ratio alone decided it: a 1400x1080 window (ratio
 * 1.3, nowhere near 4/5) wrapped into two cramped rows instead of
 * flipping, which is the state this replaces.
 *
 * Standard CSS "flip card" construction:
 * .now-playing__flip-card is the rotating element, .now-playing__primary
 * (front) sizes it via normal flow, .now-playing__lyrics (back) is
 * absolutely positioned to exactly cover that same box, and both faces
 * hide their own backface so only whichever one is currently "facing
 * forward" after the rotation is actually visible.
 *
 * Applies in compact mode too — a phone screen is portrait too, and this
 * is actually the *only* way compact mode ever gets to show lyrics at all
 * (MobileTransportControls.vue's own toolbar has no room for a side-by-side
 * split — see the toolbar's lyrics button in the template above, shown on
 * mobile specifically because this flip is how it gets used there). */
@container now-playing-stage (
  (max-aspect-ratio: 4/5) or ((max-width: 1560px) and (max-aspect-ratio: 3/2))
) {
  .now-playing__content--split {
    /* No longer sizing a side-by-side row — a single card, same footprint
     * as the non-split base rule above. */
    width: auto;
    max-width: 1000px;
    gap: 0;
    perspective: 2000px;
  }

  .now-playing__flip-card {
    display: block;
    position: relative;
    transform-style: preserve-3d;
    transition: transform 0.7s cubic-bezier(0.4, 0, 0.2, 1);
    /* NOT container-type: size on this element itself — it has no explicit
     * width, only ever getting one from .now-playing__primary's own content
     * (the artwork + title/artist/album stack) via normal flow, which is
     * exactly what size containment can't coexist with: a container query
     * container's own size, on whichever axis is being queried, has to come
     * from something other than its content, on pain of the browser having
     * nothing to lay it out from and collapsing that axis to ~0. That's not
     * a hypothetical — it's what actually happened here: card width
     * collapsed to near nothing (still holding a real, cross-axis-stretched
     * height from the flex row around it, since only *size* containment,
     * not layout, was ever the problem), and every cqw-based measurement
     * inside it — the lyrics font-size clamp, but *also* artSize/the title
     * clamp, which no longer resolved against .now-playing__stage as their
     * own comments assume once this became their nearest container-type
     * ancestor — inherited that collapse. Text wrapping to one letter per
     * line (not just one word) was the visible result. See
     * .now-playing__lyrics below for where the containment actually
     * belongs instead. */
  }

  .now-playing__content--split .now-playing__flip-card {
    transform: rotateY(180deg);
  }

  .now-playing__primary {
    /* An explicit identity rotation, not just the absence of one — Chromium
     * only reliably factors an ancestor's preserve-3d rotation into *this*
     * element's own backface-visibility check once it has a 3D transform of
     * its own to compose with that ancestor's transform in the same 3D
     * space. Without it, the artwork face stayed visibly rendered through
     * the "back" of the card instead of hiding, no matter what
     * backface-visibility said. */
    transform: rotateY(0deg);
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
  }

  .now-playing__lyrics {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    transform: rotateY(180deg);
    /* Unlike the card itself (see its own comment), this is safe: width/
     * height are already explicit (100% of .now-playing__flip-card, a
     * *positioned* ancestor with a real, content-derived size of its own —
     * a plain percentage-of-a-definite-size resolution, nothing content-
     * dependent about it) *before* containment is applied, so there's
     * nothing for it to collapse. Re-anchors every cqw/cqh unit inside this
     * element (including LyricsPanel.vue's own — plain units, not scoped to
     * a specific named container, so they always resolve against the
     * *nearest* container-type ancestor) to the same box the artwork
     * actually occupies, instead of the outer .now-playing__stage the
     * lyrics font-size clamp's own comment assumes — which is what made
     * lines wrap far narrower than intended before this existed at all. */
    container-type: size;
    /* Consumed by LyricsPanel.vue's own .lyrics-panel--immersive
     * .lyrics-panel__line rule (see its own comment) — a custom property,
     * not a value overridden from out here via a selector, since this
     * element's font-size/padding live inside a separate scoped component
     * and a plain override rule from this file would be fighting that
     * rule's own scoped specificity instead of just... telling it the
     * right number directly. Tuned against *this* box (matching the
     * artwork, not the full stage) — floor high enough to stay readable in
     * a small flip-card (mobile), ceiling capped so it doesn't blow up
     * absurdly large on a big one (a wide desktop window narrow enough to
     * still trigger flip mode). */
    --lyrics-flip-font-size: clamp(0.95rem, min(6cqw, 8cqh), 1.9rem);
    --lyrics-flip-line-padding: 10px 20px;
  }

  /* No width animation here — the flip itself carries that. But this can't
   * drop to `transition: none` outright: Vue's <transition> figures out how
   * long to keep a leaving element in the DOM by listening for *this*
   * element's own transitionend, and the flip's actual rotation lives on
   * .now-playing__flip-card (an ancestor), not here — with nothing to
   * listen for, Vue removed the lyrics panel from the DOM almost
   * immediately instead of waiting out the flip, so flipping the card back
   * visibly lost its content well before the rotation finished. Matching
   * the flip's own 0.7s duration with an opacity fade keeps a real
   * transition on the element Vue is actually watching (and reads as a
   * deliberate cross-fade layered on the flip, not just a timing workaround
   * — backface-visibility already hides each face while it's turned away,
   * so this only affects the brief moment either face is turning to/from
   * facing the viewer). */
  .now-playing-lyrics-enter-active,
  .now-playing-lyrics-leave-active {
    transition: opacity 0.7s ease;
    width: 100%;
  }

  .now-playing-lyrics-enter-from,
  .now-playing-lyrics-leave-to {
    /* width explicit here too (not just on -active above) — this and
     * -active both apply to the element at once during the transition, and
     * leaving it implicit invited relying on specificity order between two
     * differently-named selectors to resolve the conflict with the base
     * (non-flip) -enter-from/-leave-to rule's own `width: 0` instead of
     * just... not conflicting with it in the first place. */
    width: 100%;
    opacity: 0;
  }
}

/* Compact (mobile) always flips, regardless of what .now-playing__stage's
 * own measured aspect ratio comes out to. Unlike a desktop window, which
 * can genuinely be any shape, compact's "stage" height is already squeezed
 * by MobileTransportControls.vue/the tab bar below it — once that, the
 * toolbar, and the title/artist/album text are subtracted from a phone's
 * available height, the remaining box can measure out right at (or just
 * past) the max-aspect-ratio: 4/5 cutoff above, so relying on the container
 * query alone here flapped between flip and the side-by-side fallback
 * depending on device size and how long the current song's text happened
 * to be — the fallback's own lyrics column is still only 38cqw wide (see
 * .now-playing__lyrics' base rule), which is what actually produced the
 * one-word-per-line wrapping reported on a phone where the flip silently
 * never engaged. There's no side-by-side alternative on mobile ever (see
 * the toolbar lyrics button's own comment above) — flip is simply always
 * the answer here, so this repeats the container-query block above
 * verbatim under a plain class selector rather than depend on that query
 * also happening to match. */
.now-playing--compact .now-playing__content--split {
  width: auto;
  max-width: 1000px;
  gap: 0;
  perspective: 2000px;
}

.now-playing--compact .now-playing__flip-card {
  display: block;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 0.7s cubic-bezier(0.4, 0, 0.2, 1);
}

.now-playing--compact .now-playing__content--split .now-playing__flip-card {
  transform: rotateY(180deg);
}

.now-playing--compact .now-playing__primary {
  /* See the @container block above's matching rule for why this needs an
   * explicit identity transform, not just the absence of one. */
  transform: rotateY(0deg);
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}

.now-playing--compact .now-playing__lyrics {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  transform: rotateY(180deg);
  /* See the @container block above's matching rule for why containment
   * belongs here and not on .now-playing__flip-card itself, and for what
   * the custom properties below are for. */
  container-type: size;
  --lyrics-flip-font-size: clamp(0.95rem, min(6cqw, 8cqh), 1.9rem);
  --lyrics-flip-line-padding: 10px 20px;
}

.now-playing--compact .now-playing-lyrics-enter-active,
.now-playing--compact .now-playing-lyrics-leave-active {
  transition: opacity 0.7s ease;
  width: 100%;
}

.now-playing--compact .now-playing-lyrics-enter-from,
.now-playing--compact .now-playing-lyrics-leave-to {
  width: 100%;
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .now-playing__content,
  .now-playing-lyrics-enter-active,
  .now-playing-lyrics-leave-active,
  .now-playing__visualizer-row,
  .now-playing__flip-card {
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
  max-width: min(clamp(180px, min(70cqh, 50cqw), 900px), 58cqw);
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
  font-size: clamp(1.1rem, min(2.3cqw, 9cqh), 2.75rem);
  line-height: 1.15;
  overflow-wrap: break-word;
}

/* .now-playing__info .now-playing__artist-link (compound), not the class
 * alone — Vuetify's own .text-h6 utility (also on this element, see the
 * template) is a single class at the same specificity, so without a
 * compound selector to outrank it, whichever of the two happens to be
 * later in the built stylesheet wins, not necessarily this one. */
.now-playing__info .now-playing__artist-link {
  font-size: clamp(0.9rem, min(3.4cqw, 4.5cqh), 1.5rem);
  /* Block, not the anchor's default inline — inline elements ignore
   * vertical margin (mb-2 here would otherwise silently do nothing) and
   * this also keeps the centered text-align behaving exactly like the
   * plain <div> this replaced. */
  display: block;
  text-decoration: none;
  overflow-wrap: break-word;
}

.now-playing__info .now-playing__album-link {
  font-size: clamp(0.75rem, min(2.5cqw, 3.4cqh), 1rem);
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
  /* Stacked, not a row — a phone screen is narrow enough that even two
   * icon buttons side by side (now that lyrics can show here too, see the
   * flip-card container query below) reached noticeably into the artwork
   * underneath instead of staying clear of it in the corner. */
  flex-direction: column;
}

.now-playing--compact .now-playing__visualizer-row--visible {
  height: 64px;
}

/* Title/artist/album otherwise inherit the desktop clamp()s above verbatim
 * — reasonable there, but on the compact container's much narrower/shorter
 * cqw/cqh this landed with artist/album reading oversized next to a title
 * that, by comparison, could afford to be a touch bigger itself. Same
 * compound-selector-over-Vuetify-utility reasoning as the base rules above. */
.now-playing--compact .now-playing__title {
  font-size: clamp(1.2rem, min(2.4cqw, 9cqh), 2.75rem);
}

.now-playing--compact .now-playing__info .now-playing__artist-link {
  font-size: clamp(0.8rem, min(2.4cqw, 3.2cqh), 1.5rem);
}

.now-playing--compact .now-playing__info .now-playing__album-link {
  font-size: clamp(0.68rem, min(1.8cqw, 2.4cqh), 1rem);
}
</style>
