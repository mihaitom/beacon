<template>
  <div v-if="status" class="lyrics-panel__status" :class="variantClass">
    <span class="text-medium-emphasis">{{ status }}</span>
  </div>

  <div
    v-else-if="!synced"
    class="lyrics-panel__scroll lyrics-panel__scroll--plain"
    :class="variantClass"
  >
    <!-- Keeps the first and last lines out of the edge mask's fade zone
     - (see .lyrics-panel__mask-pad). The synced list below needs no
     - equivalent: its own centering pads already put every line well
     - clear of both edges. -->
    <div class="lyrics-panel__mask-pad" />
    <p class="lyrics-panel__line lyrics-panel__line--plain">{{ plainText }}</p>
    <div class="lyrics-panel__mask-pad" />
  </div>

  <div
    v-else
    ref="scrollEl"
    class="lyrics-panel__scroll"
    :class="[variantClass, { 'lyrics-panel__scroll--calibrating': calibrating }]"
    @wheel="onManualScroll"
    @touchmove="onManualScroll"
  >
    <!-- Padding elements so the first/last real line can still scroll to
     - dead-center — without these, scrollIntoView({block: 'center'}) can't
     - move a line near either end of the list past the container's own
     - edge. -->
    <div class="lyrics-panel__pad" />
    <div
      v-for="(line, index) in lines"
      :key="index"
      ref="lineRefs"
      class="lyrics-panel__line"
      :class="{
        'lyrics-panel__line--clickable': interactive,
        'lyrics-panel__line--active': index === activeIndex,
        'lyrics-panel__line--past': index < activeIndex,
      }"
      :title="lineTitle"
      @click="interactive && $emit('line-click', line)"
    >
      {{ line.text || '♪' }}
    </div>
    <div class="lyrics-panel__pad" />
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { LyricLine } from '@/services/lyrics/parseLrc'

/** The lines themselves: the status message, the plain text, or the synced
 * list following playback. No store of its own - LyricsPanel feeds it the
 * app's lyrics and playback position, the party guest page feeds it what
 * the host shares - so both read the same. */
export default {
  name: 'LyricsLines',
  props: {
    lines: {
      type: Array as PropType<LyricLine[]>,
      required: true,
    },
    synced: {
      type: Boolean,
      default: false,
    },
    /** Playback position in seconds, with any sync offset already taken
     * off. */
    position: {
      type: Number,
      default: 0,
    },
    /** Shown instead of the lines when there are none to show. */
    status: {
      type: String as PropType<string | null>,
      default: null,
    },
    variant: {
      type: String as PropType<'compact' | 'immersive'>,
      default: 'compact',
    },
    /** Lines can be clicked (to seek, or to calibrate). */
    interactive: {
      type: Boolean,
      default: false,
    },
    calibrating: {
      type: Boolean,
      default: false,
    },
    /** Changes with the song, so a new song's lines start from the top. */
    songKey: {
      type: String as PropType<string | null>,
      default: null,
    },
    /** v-model: scrolling by hand sets it, the owner hands the list back. */
    autoscrollPaused: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['line-click', 'update:autoscrollPaused'],
  data() {
    return {
      // First placement after a song's lyrics (re)load jumps instantly
      // instead of animating up from wherever the scroll happened to be.
      skipNextScrollAnimation: true,
    }
  },
  computed: {
    variantClass(): string {
      return `lyrics-lines--${this.variant}`
    },
    plainText(): string {
      return this.lines.map((line) => line.text).join('\n')
    },
    lineTitle(): string | undefined {
      if (!this.interactive) return undefined
      return this.calibrating ? this.$t('lyrics.calibrateHere') : this.$t('lyrics.seekHere')
    },
    // Index of the last line whose timestamp has passed — lines are always
    // time-sorted ascending (see services/lyrics/parseLrc.ts), so this is
    // "how far into the list has playback gotten."
    activeIndex(): number {
      if (!this.synced) return -1
      let index = -1
      for (let i = 0; i < this.lines.length; i++) {
        if (this.lines[i]!.time > this.position) break
        index = i
      }
      return index
    },
  },
  watch: {
    // A new song's lyrics replacing the old ones — reset scroll to the top
    // immediately (this component instance persists across song changes,
    // its scroll position doesn't reset on its own) and let the next
    // activeIndex placement below jump instantly rather than animate.
    songKey() {
      this.skipNextScrollAnimation = true
      const el = this.$refs.scrollEl as HTMLElement | undefined
      if (el) el.scrollTop = 0
    },
    // Lyrics arriving (or being swapped for a different match) mid-song:
    // jump straight to where playback already is, without animating up
    // from the top. activeIndex alone doesn't cover this — it may well be
    // the same number it already was while the list was still empty, in
    // which case its watcher below returns early and nothing scrolls until
    // the *next* line boundary comes round, which is what left freshly
    // loaded lyrics sitting at line one for up to several seconds.
    lines() {
      this.skipNextScrollAnimation = true
      this.jumpToActive()
    },
    // immediate: true — mounting straight into an already-loaded, mid-song
    // position (opening Now Playing partway through a track) would
    // otherwise leave the scroll at the top until the *next* line boundary.
    activeIndex: {
      immediate: true,
      handler(newIndex: number, oldIndex: number | undefined) {
        if (newIndex < 0 || newIndex === oldIndex) return
        this.jumpToActive()
      },
    },
    // Handed back (the resume button, or calibration ending): straight to
    // the line that is playing rather than animating there - the point is
    // to get back to it, not to watch the journey.
    autoscrollPaused(paused: boolean) {
      if (paused) return
      this.skipNextScrollAnimation = true
      this.jumpToActive()
    },
  },
  methods: {
    /** Scrolls once the new lines are actually in the DOM *and* laid out.
     * nextTick alone isn't enough: it fires when Vue has patched the DOM,
     * which is before the browser has given those elements a height, and
     * scrollIntoView() on a zero-height element lands nowhere useful. */
    jumpToActive() {
      this.$nextTick(() => requestAnimationFrame(() => this.scrollToActive()))
    },
    scrollToActive() {
      if (this.autoscrollPaused) return
      const el = (this.$refs.lineRefs as HTMLElement[] | undefined)?.[this.activeIndex]
      el?.scrollIntoView({
        behavior: this.skipNextScrollAnimation ? 'auto' : 'smooth',
        block: 'center',
      })
      this.skipNextScrollAnimation = false
    },
    /** Scrolling by hand takes the list over: autoscroll stops and stays
     * stopped until the owner hands it back deliberately. It used to
     * resume itself after a few seconds, which read as the panel fighting
     * back - you scroll up to read an earlier verse, and mid-sentence it
     * yanks you to wherever the song has got to. */
    onManualScroll() {
      if (!this.autoscrollPaused) this.$emit('update:autoscrollPaused', true)
    },
  },
}
</script>

<style scoped>
.lyrics-panel__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
  /* Signals "more content above/below" without a hard cutoff, and works
   * regardless of what's behind the panel (solid surface in the compact
   * drawer, blurred album art in the immersive view) — an alpha mask, not
   * a background-color overlay, is what makes that background-agnostic.
   *
   * The fade depth is a custom property because .lyrics-panel__mask-pad
   * below has to match it exactly: content that starts inside this zone
   * renders permanently half-faded, which is a bug, not a hint. */
  --lyrics-mask-fade: 15%;
  mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    black var(--lyrics-mask-fade),
    black calc(100% - var(--lyrics-mask-fade)),
    transparent 100%
  );
}

.lyrics-panel__scroll::-webkit-scrollbar {
  display: none;
}

/* Unlike the synced view — where autoscroll itself signals "you can
 * follow along" and a hidden scrollbar reads as deliberate polish —
 * unsynced lyrics have nothing driving the view, so a visible (if
 * subtle) scrollbar is what makes "you can freely scroll this" obvious
 * rather than something you have to discover by accident. */
.lyrics-panel__scroll--plain {
  /* Centered while the text fits, top-aligned (and scrollable) once it
   * doesn't — `safe` is what makes that switch automatic. Without it,
   * centering overflowing content in a scroll container pushes the start of
   * it above the scrollport, where it can't be scrolled back to. Unsynced
   * lyrics have nothing scrolling them on their own, so a short set sitting
   * at the very top of a tall panel reads as if it had been cut off.
   * The mask pads stay in the flow either way: at the top of a scrolling
   * set they keep the first and last lines clear of the edge fade, and in a
   * centered short set they simply sit either side of it. */
  display: flex;
  flex-direction: column;
  justify-content: safe center;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.25) transparent;
}

.lyrics-panel__scroll--plain::-webkit-scrollbar {
  display: block;
  width: 6px;
}

.lyrics-panel__scroll--plain::-webkit-scrollbar-track {
  background: transparent;
}

.lyrics-panel__scroll--plain::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.25);
  border-radius: 3px;
}

/* The immersive view is the full-screen one, where the lyrics *are* the
 * page — a scrollbar down the side of it reads as chrome bolted onto
 * artwork. The compact drawer keeps it: that panel is small, sits among
 * other controls, and unsynced lyrics there need something saying "this
 * scrolls" (see .lyrics-panel__scroll--plain above). Scrolling itself is
 * untouched either way. */
.lyrics-lines--immersive.lyrics-panel__scroll--plain {
  scrollbar-width: none;
}

.lyrics-lines--immersive.lyrics-panel__scroll--plain::-webkit-scrollbar {
  display: none;
}

.lyrics-panel__pad {
  /* Half the panel's own height — lets scrollIntoView({block: 'center'})
   * actually center the first/last real line instead of stopping short at
   * the scroll container's hard edge. */
  height: 50%;
  flex-shrink: 0;
}

/* Unsynced lyrics are one block of text with nothing scrolling it, so they
 * sit at the very top of the container — which is exactly where the edge
 * mask above is still fading in, leaving the first line permanently
 * half-transparent (and the last one likewise at the bottom). This clears
 * that zone. A percentage *height* on an element rather than padding on
 * the container: percentage padding resolves against the container's
 * width, which has nothing to do with where the mask sits. */
.lyrics-panel__mask-pad {
  height: var(--lyrics-mask-fade);
  flex-shrink: 0;
}

.lyrics-panel__line {
  padding: 8px 0;
  font-weight: 600;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.55);
  text-align: center;
  margin: 0 auto;
  /* scale(), not font-size — font-size changes the line's own layout box,
   * which reflows/shifts every line below it as soon as one becomes
   * active (worse yet on a wrapped multi-line entry, where the box grows
   * taller too). A transform only changes the rendered pixels, not layout,
   * so neighbors never move. Scaling from the center (not an edge) means
   * the growth is symmetric — each variant's max-width below reserves
   * exactly enough margin on both sides that even a line filling the
   * entire box can't scale past the panel's own edge. */
  transform-origin: center;
  transform: scale(1);
  transition:
    color 0.25s ease,
    opacity 0.25s ease,
    transform 0.25s ease,
    text-shadow 0.25s ease;
}

.lyrics-panel__line--clickable {
  cursor: pointer;
}

.lyrics-panel__line--clickable:hover:not(.lyrics-panel__line--active) {
  color: rgba(255, 255, 255, 0.85);
}

.lyrics-panel__line--past {
  opacity: 0.55;
}

.lyrics-panel__line--active {
  color: #fdf6ec;
  opacity: 1;
  text-shadow: 0 0 24px rgba(245, 169, 78, 0.45);
}

.lyrics-panel__line--plain {
  white-space: pre-line;
  color: rgba(255, 255, 255, 0.55);
  font-weight: 400;
  line-height: 1.7;
}

/* Both no-lyrics states (looking, and none found) — one box, so the
 * message changes without the panel around it moving. */
.lyrics-panel__status {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
}

/* Compact (docked drawer) — centered, modest scale. max-width 85% is
 * derived from the active scale below (1.15): a line filling the full
 * box would grow to 1.15× on each side, i.e. 0.075 of the box's own
 * width past its edge — capping the box at 1/1.15 ≈ 87% of the panel
 * leaves enough margin either side to absorb that with room to spare. */
.lyrics-lines--compact .lyrics-panel__line {
  font-size: 1rem;
  padding: 8px 20px;
  max-width: 85%;
}

.lyrics-lines--compact .lyrics-panel__line--active {
  transform: scale(1.15);
}

/* Immersive (fullscreen Now Playing) — centered, much larger. Same
 * headroom math as compact above, for a 1.25× active scale: capped at
 * 1/1.25 = 80% of the panel, kept at 78% for a small safety margin.
 *
 * cqw/cqh, not a fixed rem — this renders inside NowPlayingView.vue's
 * .now-playing__stage (a container-type: size host, see its own comment),
 * the same measurement basis the artwork/title there already scale
 * against. A fixed size here read proportionally huge on a small window
 * and small on a large one, exactly the bug the title had before it got
 * the same treatment. cqw is scaled down from .now-playing__lyrics' own
 * ~38cqw box width (container query units measure against the *stage*,
 * not this narrower column, so the multiplier has to account for that
 * gap) rather than assuming the full stage width.
 *
 * font-size/padding read through a custom property, not a literal value
 * directly here — NowPlayingView.vue's flip-card layout (portrait/narrow
 * monitors *and* mobile, see its own comment) reuses this same class but
 * measures cqw/cqh against a completely different, much smaller container
 * (the artwork's own box, not the full stage), so the coefficients above
 * are wrong there by roughly an order of magnitude — a custom property set
 * on .now-playing__lyrics (inherited down into every line here, since it's
 * the same element as .lyrics-panel via Vue's class fallthrough) is how
 * that parent overrides this without fighting this rule's own specificity
 * from outside a scoped child component. Unset (plain split-mode layout)
 * falls back to the literal value that was always here. */
.lyrics-lines--immersive .lyrics-panel__line {
  font-size: var(--lyrics-flip-font-size, clamp(1.1rem, min(2.2cqw, 3.5cqh), 1.9rem));
  padding: var(--lyrics-flip-line-padding, 12px 32px);
  max-width: 78%;
}

.lyrics-lines--immersive .lyrics-panel__line--active {
  transform: scale(1.25);
}

.lyrics-lines--immersive .lyrics-panel__line--plain {
  font-size: clamp(0.95rem, min(1.8cqw, 2.8cqh), 1.5rem);
  max-width: 640px;
  margin: 0 auto;
}

/* Armed by the target button in .lyrics-panel__sync below — the next
 * line click calibrates instead of seeking, so both the cursor and the
 * hover glow borrow the active-line's own amber "beacon" language to
 * signal "clicking now does something different." */
.lyrics-panel__scroll--calibrating {
  cursor: crosshair;
}

.lyrics-panel__scroll--calibrating .lyrics-panel__line--clickable:hover {
  color: #fdf6ec;
  text-shadow: 0 0 16px rgba(245, 169, 78, 0.5);
}

@media (prefers-reduced-motion: reduce) {
  .lyrics-panel__line {
    transition: none;
  }

  .lyrics-panel__scroll {
    scroll-behavior: auto;
  }
}
</style>
