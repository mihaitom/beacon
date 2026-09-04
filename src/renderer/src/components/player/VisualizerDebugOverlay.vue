<template>
  <div v-if="debugSyncEnabled && debug" class="visualizer-debug-overlay">
    <div>Visualizer: {{ debug.visualizer.toFixed(2) }}s</div>
    <div>Cast: {{ debug.cast.toFixed(2) }}s</div>
    <div
      class="visualizer-debug-overlay-delta"
      :class="{ 'visualizer-debug-overlay-delta--off': deltaLooksOff }"
    >
      Δ: {{ debugDelta >= 0 ? '+' : '' }}{{ debugDelta.toFixed(2) }}s
    </div>
    <!-- Radio-relayed-Sonos only — see VisualizerFrame's own comment on why
    the delta above can't tell "still the fixed guess" apart from "a real
    measurement landed" without this. -->
    <div
      v-if="debug.lead"
      class="visualizer-debug-overlay-lead"
      :class="{ 'visualizer-debug-overlay-lead--measured': debug.lead.measured }"
    >
      Lead: {{ debug.lead.seconds.toFixed(2) }}s ({{
        debug.lead.measured ? 'measured' : 'guessed'
      }})
    </div>
  </div>
</template>

<script lang="ts">
import { getLogLevel } from '@/services/connect/logLevel'
import type { VisualizerFrame } from '@/services/connect/types'

// AudioVisualizer.vue's 'cast'-mode sync debug readout — split into its own
// component, positioned absolutely by NowPlayingView.vue rather than drawn
// inside AudioVisualizer itself, after an earlier version that lived there
// either sat on top of the bars (covering them) or took real flex space
// away from them (visibly compressing them) — reported live 2026-09-05,
// twice, once for each layout tried. AudioVisualizer's own box is exactly
// the bars' box, with nothing to spare either way; this one lives in
// NowPlayingView's own layout instead; see .now-playing's own CSS for the
// positioning context, and NowPlayingView.vue for why `debug` is simply
// whatever AudioVisualizer's own 'debug-frame' event last carried, not
// fetched independently here — a second GET /visualizer subscription would
// mean a second reader draining the exact same, single-consumer frames
// queue (core/audio_analysis.py's AudioAnalyzer.frames), splitting frames
// between the two connections and starving the actual bars of some of
// them, not just adding a redundant one.
//
// Deliberately not run through $t(): a diagnostic for whoever just turned
// the log level to DEBUG/TRACE to chase a sync bug, not user-facing copy.
export default {
  name: 'VisualizerDebugOverlay',
  props: {
    // AudioVisualizer.vue's own 'debug-frame' event, forwarded straight
    // through by NowPlayingView.vue — null whenever nothing has arrived
    // yet, or 'cast' mode isn't running at all right now.
    debug: {
      type: Object as () => VisualizerFrame['debug'] | null,
      default: null,
    },
  },
  data() {
    return {
      // Whether the account's backend log level is DEBUG/TRACE right now —
      // fetched once at mount, same reasoning AudioVisualizer.vue's own
      // reducedMotion has: this gates a diagnostic overlay, not something
      // that needs to react to Settings being changed in another window
      // mid-session.
      debugSyncEnabled: false,
    }
  },
  computed: {
    // How far apart the visualizer's own clock and the general cast clock
    // currently read, both already re-based to the same zero point by the
    // backend (see VisualizerFrame's own comment) — this is the number the
    // listener asked for a way to actually see, instead of only ever being
    // able to guess "does this look right" from the bars alone. A small,
    // roughly steady value is healthy (SSE/render jitter, a few tens of
    // ms); a large or steadily *growing* one is the sync bug this exists to
    // catch — but see deltaLooksOff's own comment for what it can't tell
    // apart on its own.
    debugDelta(): number {
      if (!this.debug) return 0
      return this.debug.visualizer - this.debug.cast
    },
    // Purely a visual flag, not a verdict: a real delta this large could be
    // either clock — the general one (core/playback_clock.py's own resync)
    // or the visualizer's own (core/visualizer_feed.py's
    // _OffsetTrackerClock/_FirstByteClock) reading wrong, and this overlay
    // has no way to tell which from here. What it does rule out is "am I
    // just imagining this from the bars" — a steady green (unhighlighted)
    // number here means the two backend clocks agree with each other,
    // whatever the speaker itself is actually doing.
    deltaLooksOff(): boolean {
      // Above this, the delta is highlighted rather than shown in the same
      // muted style as the rest of the overlay — a difference this size is
      // audible, not just a rounding curiosity.
      return Math.abs(this.debugDelta) >= 0.75
    },
  },
  mounted() {
    // Best-effort — GET /log-level failing (offline, a very old backend
    // without the route) just means the overlay stays off, same as it
    // would for anyone not chasing a sync bug in the first place.
    getLogLevel()
      .then(({ level }) => {
        this.debugSyncEnabled = level === 'DEBUG' || level === 'TRACE'
      })
      .catch(() => {})
  },
}
</script>

<style scoped>
/* Fixed dark backdrop rather than a theme-aware one on purpose: this can
   sit over a blurred artwork backdrop or the visualizer's own colored
   bars, not over the app's ordinary surface, so it needs to stay readable
   regardless of the current theme rather than blending into it. */
.visualizer-debug-overlay {
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba(255, 255, 255, 0.92);
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  user-select: text;
}

.visualizer-debug-overlay-delta {
  color: rgba(140, 255, 170, 0.95);
}

.visualizer-debug-overlay-delta--off {
  color: rgba(255, 120, 120, 0.95);
  font-weight: 600;
}

.visualizer-debug-overlay-lead {
  color: rgba(255, 210, 130, 0.95);
}

.visualizer-debug-overlay-lead--measured {
  color: rgba(140, 255, 170, 0.95);
}
</style>
