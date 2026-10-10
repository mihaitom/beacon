<template>
  <div
    ref="root"
    class="now-playing"
    :style="{ '--photo-scrim': scrimStrength }"
    :class="{
      'now-playing--compact': compact,
      'now-playing--landscape': isLandscape,
      'now-playing--wide-stage': isLandscape && source.ui.artworkHidden,
      'now-playing--photo': photoOnly,
      'now-playing--artwork-hidden': source.ui.artworkHidden,
    }"
  >
    <now-playing-backdrop
      :source="source.backdrop.source"
      :is-artist="source.backdrop.isArtist"
      :scrim-style="source.ambientStyle"
    />
    <!-- Wherever the text (and on a phone held sideways the controls) sits
     - low over the picture: darkened from the bottom up, more over a light
     - photo than a dark one. -->
    <div v-if="bottomScrim" class="now-playing__bottom-scrim" />

    <now-playing-toolbar
      v-if="!isLandscape"
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
      <now-playing-stage-mobile v-if="compact" :landscape="isLandscape" />
      <now-playing-stage-desktop v-else />
    </div>

    <!-- On a phone held sideways the stage is one column, holding the
     - artwork or the lyrics behind it; the toolbar, the track text and the
     - host's controls take the other. See the grid in <style>. -->
    <template v-if="isLandscape">
      <div class="now-playing__side-toolbar">
        <now-playing-toolbar compact inline :is-fullscreen="isFullscreen">
          <slot name="toolbar-actions" />
        </now-playing-toolbar>
      </div>
      <now-playing-track-panels
        v-if="hasPlayable"
        compact
        landscape
        :align-start="photoOnly"
        :mini-cover="photoOnly"
        class="now-playing__side-info"
      />
    </template>

    <!-- Real audio-reactive either way: a local Web Audio analyser during
     - local playback, or the backend's own real-time analysis (see
     - connect/core/audio_analysis.py) while casting to a target it can
     - actually run against. The row itself lives in
     - NowPlayingVisualizer.vue (its own height transition, mount/hide delay
     - and compact height). -->
    <now-playing-visualizer v-if="!isLandscape" :compact="compact" />

    <div v-if="isLandscape" class="now-playing__side-controls">
      <slot name="controls" />
    </div>

    <!-- Positioned in .now-playing's own layout (which is already
     - `position: relative`, see its own CSS), not inside the bars or
     - .now-playing__visualizer-row above — see VisualizerDebugOverlay's
     - own comment for why living inside them either covered the bars or
     - compressed them, reported live 2026-09-05 both times. This
     - way it can never do either: it takes no layout space from the
     - visualizer row at all, floating over whatever's underneath instead
     - (the artwork/backdrop area, not the bars themselves, for the
     - top-left corner this actually renders in). -->
    <component
      :is="source.debugOverlayComponent"
      v-if="source.debugOverlayComponent"
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
import NowPlayingTrackPanels from '@/components/now-playing/NowPlayingTrackPanels.vue'
import { nowPlayingSourceMixin } from '@/components/now-playing/useSource'
import { appAccent } from '@/services/appAccent'
import {
  bottomScrimStrength,
  colourBehindControls,
  measureBottomColor,
  type Rgb,
} from '@/services/imageBrightness'
import { liftForContrast } from '@/services/visualizerColor'

// Warm amber — the same signal color the app is named after (see main.ts's
// 'beacon' theme) — used whenever there's nothing to extract a color from
// yet (radio has no artwork, or extraction is still in flight/failed).
const FALLBACK_COLOR = '245, 169, 78'

/** The shared Now Playing presentation: the backdrop, the toolbar, whichever
 * stage fits (desktop side-by-side, phone flip card), the visualizer and the
 * debug overlay, all read from the injected source. Rendered by the host
 * view and, for party guests, by their own shell. It owns everything that is
 * about the screen rather than the data: the flip/slide mechanics, the
 * accent colour and fullscreen.
 *
 * The `controls` slot is the host's transport, shown here only in
 * landscape; upright, each host places its own under the presentation. */
export default {
  name: 'NowPlayingPresentation',
  components: {
    NowPlayingStageMobile,
    NowPlayingStageDesktop,
    NowPlayingBackdrop,
    NowPlayingVisualizer,
    NowPlayingToolbar,
    NowPlayingTrackPanels,
  },
  mixins: [nowPlayingSourceMixin],
  props: {
    compact: {
      type: Boolean,
      default: false,
    },
    /** A phone on its side (see composables/phoneLandscape.ts): two columns
     * instead of one. Only read together with `compact`. */
    landscape: {
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
      // The artist photo's bottom band, for the scrim and the accent over
      // it - null until measured, or where it cannot be.
      bottomColour: null as Rgb | null,
    }
  },
  computed: {
    isLandscape(): boolean {
      return this.compact && this.landscape
    },
    hasPlayable(): boolean {
      return this.source.song != null || this.source.radio != null
    },
    /** Sideways with neither artwork nor lyrics: nothing to give a column
     * to, so the photo has the screen and the text and controls line its
     * bottom edge. */
    photoOnly(): boolean {
      return this.isLandscape && this.source.ui.artworkHidden && !this.source.ui.lyricsOpen
    },
    /** On a phone held sideways always, the text being over the backdrop
     * either way; otherwise where it sits on the photo with the artwork
     * hidden. */
    bottomScrim(): boolean {
      return this.isLandscape || this.source.ui.artworkHidden
    },
    /** The photo the scrim is measured against. Only a sharp artist photo
     * varies enough to need it: the blurred cover is darkened already. */
    scrimPhoto(): string | null {
      return this.bottomScrim && this.source.backdrop.isArtist ? this.source.backdrop.source : null
    },
    scrimStrength(): number {
      return bottomScrimStrength(this.bottomColour)
    },
    /** The bars' colour, which the whole app's accent follows. Where the
     * text (and on a phone held sideways the controls) sits on the photo, it
     * is lifted until it stands off what is behind them there. */
    accent(): string {
      const color = this.source.visualizer.color
      if (!this.bottomColour) return color
      return liftForContrast(color, colourBehindControls(this.bottomColour, this.scrimStrength))
    },
  },
  watch: {
    scrimPhoto: {
      immediate: true,
      async handler(url: string | null) {
        this.bottomColour = null
        if (!url) return
        const colour = await measureBottomColor(url)
        // A later photo may have arrived while this one was measured.
        if (this.scrimPhoto === url) this.bottomColour = colour
      },
    },
    // The whole app's accent follows the bars for as long as this view is on
    // screen: the artist background's own colour takes over the theme's
    // primary, so buttons, the player bar and everything else tint along
    // with the picture. Reset on the way out (beforeUnmount).
    accent: {
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
  /* What the lyrics stand on, in every stage: a soft darkening that fades
   * out towards every edge of their box, so it reads as shade behind the
   * text rather than as a panel. As strong as the photo needs (see
   * --photo-scrim, set from the measured photo). */
  --lyrics-ground: radial-gradient(
    ellipse farthest-side,
    rgba(0, 0, 0, calc(var(--photo-scrim) * 0.75)) 0%,
    rgba(0, 0, 0, calc(var(--photo-scrim) * 0.5)) 50%,
    rgba(0, 0, 0, calc(var(--photo-scrim) * 0.15)) 82%,
    rgba(0, 0, 0, 0) 100%
  );
}

/* Mirrors the toolbar's own corner placement (opposite side, so
 * the two never collide) — see VisualizerDebugOverlay's own comment for
 * why this lives here rather than inside the bars/the visualizer
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

/* Sideways: the stage on the left, at full height - as wide as the screen
 * is tall while it holds the artwork, so the cover can take that height.
 * cqh: each shell makes the box this fills a size container, so the column
 * follows its real height (without one, cqh falls back to svh). The right column has the toolbar at the top and, from
 * the bottom up, the controls and the track text centred over them. No
 * visualizer: its bars only read as a floor along the screen's own bottom
 * edge, which the controls take here. */
.now-playing.now-playing--landscape {
  grid-template-columns: minmax(0, min(100cqh, 50%)) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto auto;
  grid-template-areas:
    'stage .'
    'stage info'
    'stage controls';
  justify-items: stretch;
}

/* With the artwork hidden there is no square to size the stage by: the
 * lyrics take everything left of the controls' column. */
.now-playing.now-playing--landscape.now-playing--wide-stage {
  grid-template-columns: minmax(0, 1fr) minmax(0, min(400px, 50%));
}

/* Nothing on the stage at all: the text in the bottom-left corner, the
 * controls bottom right. */
.now-playing.now-playing--landscape.now-playing--photo {
  grid-template-columns: minmax(0, 1fr) minmax(0, min(420px, 55%));
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas:
    'stage stage'
    'info controls';
}

/* Not clipped at the column's edge, where the artwork's glow would end in a
 * hard line; .now-playing itself still clips at the screen's. */
.now-playing--landscape .now-playing__stage {
  grid-area: stage;
  overflow: visible;
}

/* Under everything that is content (z-index 1), over the photo. */
.now-playing__bottom-scrim {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    to top,
    rgba(0, 0, 0, var(--photo-scrim)) 0%,
    rgba(0, 0, 0, calc(var(--photo-scrim) * 0.55)) 40%,
    rgba(0, 0, 0, 0) 75%
  );
}

/* Upright and on the desktop the text is a short block at the bottom of a
 * tall stage: the same darkening, kept to the band it and the visualizer
 * below it occupy. */
.now-playing:not(.now-playing--landscape) .now-playing__bottom-scrim {
  background: linear-gradient(
    to top,
    rgba(0, 0, 0, var(--photo-scrim)) 0%,
    rgba(0, 0, 0, calc(var(--photo-scrim) * 0.55)) 25%,
    rgba(0, 0, 0, 0) 55%
  );
}

/* Placed by line rather than by area: over the photo-only layout's stage
 * it shares the top-right corner with it. */
.now-playing__side-toolbar {
  grid-row: 1;
  grid-column: 2;
  justify-self: end;
  align-self: start;
  position: relative;
  z-index: 2;
  padding: 12px 16px 0;
}

/* A container so the text's cqw sizes measure its own column. */
.now-playing__side-info {
  grid-area: info;
  position: relative;
  z-index: 1;
  min-width: 0;
  container-type: inline-size;
  padding: 0 16px 4px;
}

/* Level with the bottom of the controls beside it. */
.now-playing--photo .now-playing__side-info {
  align-self: end;
  padding-bottom: 18px;
}

/* Clear of the screen's bottom edge, where both phone platforms listen for
 * their swipe-up gesture. */
.now-playing__side-controls {
  grid-area: controls;
  position: relative;
  z-index: 1;
  padding-bottom: 12px;
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
