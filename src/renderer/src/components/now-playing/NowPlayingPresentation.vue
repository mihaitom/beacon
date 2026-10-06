<template>
  <div
    ref="root"
    class="now-playing"
    :class="{
      'now-playing--compact': compact,
      'now-playing--artwork-hidden': source.ui.artworkHidden,
    }"
  >
    <now-playing-backdrop
      :source="source.backdrop.source"
      :is-artist="source.backdrop.isArtist"
      :scrim-style="source.ambientStyle"
    />

    <now-playing-toolbar
      :compact="compact"
      :is-fullscreen="isFullscreen"
      @toggle-fullscreen="toggleFullscreen"
    >
      <!-- A party guest's own control (the skip vote) is passed in here. -->
      <slot name="toolbar-actions" />
    </now-playing-toolbar>

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
      <now-playing-stage-mobile v-if="compact" />
      <now-playing-stage-desktop v-else />
    </div>

    <!-- Real audio-reactive either way: a local Web Audio analyser during
     - local playback, or the backend's own real-time analysis (see
     - connect/core/audio_analysis.py) while casting to a target it can
     - actually run against. The row itself lives in
     - NowPlayingVisualizer.vue (its own height transition, mount/hide delay
     - and compact height). -->
    <now-playing-visualizer :compact="compact" />

    <!-- Positioned in .now-playing's own layout (which is already
     - `position: relative`, see its own CSS), not inside <audio-visualizer>
     - or .now-playing__visualizer-row above — see VisualizerDebugOverlay's
     - own comment for why living inside AudioVisualizer either covered the
     - bars or compressed them, reported live 2026-09-05 both times. This
     - way it can never do either: it takes no layout space from the
     - visualizer row at all, floating over whatever's underneath instead
     - (the artwork/backdrop area, not the bars themselves, for the
     - top-left corner this actually renders in). -->
    <visualizer-debug-overlay
      :debug="source.visualizer.debug"
      class="now-playing__visualizer-debug"
    />
  </div>
</template>

<script lang="ts">
import NowPlayingStageMobile from '@/components/now-playing/NowPlayingStageMobile.vue'
import NowPlayingStageDesktop from '@/components/now-playing/NowPlayingStageDesktop.vue'
import NowPlayingBackdrop from '@/components/now-playing/NowPlayingBackdrop.vue'
import NowPlayingVisualizer from '@/components/now-playing/NowPlayingVisualizer.vue'
import NowPlayingToolbar from '@/components/now-playing/NowPlayingToolbar.vue'
import { nowPlayingSourceMixin } from '@/components/now-playing/useSource'
import VisualizerDebugOverlay from '@/components/player/VisualizerDebugOverlay.vue'
import { appAccent } from '@/services/appAccent'

// Warm amber — the same signal color the app is named after (see main.ts's
// 'beacon' theme) — used whenever there's nothing to extract a color from
// yet (radio has no artwork, or extraction is still in flight/failed).
const FALLBACK_COLOR = '245, 169, 78'

/** The shared Now Playing presentation: the backdrop, the toolbar, whichever
 * stage fits (desktop side-by-side, phone flip card), the visualizer and the
 * debug overlay, all read from the injected source. Rendered by the host
 * view and, for party guests, by their own shell. It owns everything that is
 * about the screen rather than the data: the flip/slide mechanics, the
 * accent colour and fullscreen. */
export default {
  name: 'NowPlayingPresentation',
  components: {
    NowPlayingStageMobile,
    NowPlayingStageDesktop,
    NowPlayingBackdrop,
    NowPlayingVisualizer,
    NowPlayingToolbar,
    VisualizerDebugOverlay,
  },
  mixins: [nowPlayingSourceMixin],
  props: {
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
      // Tracks the real DOM state (via the fullscreenchange listener below),
      // not just "did we ask for it" — the browser/OS can exit fullscreen on
      // its own (Esc key, an OS-level shortcut), and the button's icon/title
      // need to reflect that either way.
      isFullscreen: false,
    }
  },
  watch: {
    // The whole app's accent follows the bars for as long as this view is on
    // screen: the artist background's own colour takes over the theme's
    // primary, so buttons, the player bar and everything else tint along
    // with the picture. Reset on the way out (beforeUnmount).
    'source.visualizer.color': {
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
  },
  beforeUnmount() {
    this.stageObserver?.disconnect()
    this.endSlide?.()
    document.removeEventListener('fullscreenchange', this.onFullscreenChange)
    // The borrowed accent goes back with the view.
    this.applyPrimary(FALLBACK_COLOR)
    // Leaving shouldn't strand the whole window in fullscreen with nothing
    // controlling it anymore.
    if (document.fullscreenElement === this.$refs.root) void document.exitFullscreen()
  },
  methods: {
    /** Puts `color` - an "r, g, b" triplet - into the theme's primary slot,
     * and mirrors it for the canvas components that cannot read a CSS
     * variable (the waveform). Going through the theme object rather than
     * the --v-theme-primary variable directly is what lets Vuetify
     * re-derive `on-primary` for it, so text on a primary surface keeps its
     * contrast. */
    applyPrimary(color: string): void {
      appAccent.value = color
      const theme = this.$vuetify.theme
      const colors = theme.themes[theme.name]?.colors
      if (colors) colors.primary = `rgb(${color})`
    },
    /** Requests fullscreen on this view's own root element, not
     * document.documentElement — the point is hiding the rest of the app
     * chrome around it, not just the OS/browser window frame. */
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
     * jump the slide compensates. */
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
   * it's nested inside its shell's grid, sharing that same total viewport
   * height with whatever sits below it. 100% instead just fills whatever
   * height that already-correctly-sized grid cell gives it. */
  height: 100%;
}

.now-playing--compact .now-playing__visualizer-debug {
  /* bottom: auto is load-bearing, not tidying: the desktop rule above sets
   * bottom: 370px, and an absolutely positioned box with height: auto and
   * *both* offsets given gets stretched to span between them. Adding top
   * alone turned this small badge into a tall dark column of its own
   * translucent background, straight down the artwork. */
  top: 8px;
  bottom: auto;
  left: 8px;
}
</style>
