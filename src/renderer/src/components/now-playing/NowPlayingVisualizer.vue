<template>
  <!-- Always in the DOM (unlike <audio-visualizer> itself, still v-if'd
   - below) so its height can *transition* between 0 and its real height
   - instead of the row just appearing/disappearing — .now-playing__stage is
   - a grid `auto` sibling, so animating this row's height is what makes the
   - artwork's cqh-driven size resize smoothly along with it instead of
   - snapping the instant this mounts/unmounts. <audio-visualizer> itself
   - stays mounted a moment past `active` going false so its own smoothing
   - can let the bars settle to 0 first instead of just vanishing — see the
   - active watcher; that settle plays out over the same
   - VISUALIZER_HIDE_DELAY_MS this row's own height transition takes, so both
   - finish together. -->
  <div
    class="now-playing__visualizer-row"
    :class="{
      'now-playing__visualizer-row--visible': mounted,
      'now-playing__visualizer-row--compact': compact,
    }"
  >
    <audio-visualizer
      v-if="mounted"
      :active="active"
      :color="color"
      @debug-frame="$emit('debug-frame', $event)"
    />
  </div>
</template>

<script lang="ts">
import AudioVisualizer from '@/components/player/AudioVisualizer.vue'

// How long <audio-visualizer> stays mounted (with active=false) after the
// `active` prop goes false — long enough for its own smoothing to visibly
// settle every bar to 0 before it's actually removed.
const VISUALIZER_HIDE_DELAY_MS = 400

export default {
  name: 'NowPlayingVisualizer',
  components: { AudioVisualizer },
  props: {
    /** Whether the visualizer should be showing at all (something playable,
     * the preference on, and an analyser/backend data source available). */
    active: {
      type: Boolean,
      default: false,
    },
    color: {
      type: String,
      required: true,
    },
    compact: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['debug-frame'],
  data() {
    return {
      // Whether <audio-visualizer> is actually in the DOM — trails `active`
      // by VISUALIZER_HIDE_DELAY_MS on the way down so its fall-to-0
      // animation has time to play before it's removed.
      mounted: false,
      hideTimer: null as ReturnType<typeof setTimeout> | null,
    }
  },
  watch: {
    // Mount instantly on the way up; on the way down, keep it mounted (with
    // active=false) for VISUALIZER_HIDE_DELAY_MS so AudioVisualizer's own
    // smoothing can settle every bar to 0 first.
    active: {
      immediate: true,
      handler(active: boolean) {
        if (this.hideTimer) {
          clearTimeout(this.hideTimer)
          this.hideTimer = null
        }
        if (active) {
          this.mounted = true
        } else if (this.mounted) {
          this.hideTimer = setTimeout(() => {
            this.mounted = false
          }, VISUALIZER_HIDE_DELAY_MS)
        }
      },
    },
  },
  beforeUnmount() {
    if (this.hideTimer) clearTimeout(this.hideTimer)
  },
}
</script>

<style scoped>
/* Padding lives here, not on the canvas — a canvas's own CSS padding would
 * desync from its drawing buffer (sized off getBoundingClientRect, which
 * includes padding), pushing the bars off-center from where the bitmap
 * actually paints. A real flex row (fixed height) rather than the
 * absolutely-positioned overlay this used to be — .now-playing__stage
 * shrinks to make room for it through normal flex arithmetic, so nothing
 * here needs a guessed padding-bottom on the content above it to avoid
 * overlapping. */
.now-playing__visualizer-row {
  position: relative;
  z-index: 1;
  /* Row 2 of .now-playing's grid is `auto` — sizes to this element's own
   * actual height, which is what makes the transition below animate
   * .now-playing__stage's own share of the grid smoothly instead of
   * snapping. 0 at rest; --visible sets the real height. */
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

.now-playing__visualizer-row--compact.now-playing__visualizer-row--visible {
  height: 64px;
}

@media (prefers-reduced-motion: reduce) {
  .now-playing__visualizer-row {
    transition: none;
  }
}
</style>
