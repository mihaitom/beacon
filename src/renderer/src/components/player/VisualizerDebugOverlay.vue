<template>
  <div v-if="debugSyncEnabled && debug" class="visualizer-debug-overlay">
    <!-- A legend rather than a v-tooltip per line, which was the first
     - thought: these numbers are read against each other while something
     - is playing, so what each one means has to be on screen at the same
     - time as all of them, not one at a time under a pointer that is busy
     - hovering somewhere else. Folded away by default — it is four lines
     - of prose over the artwork, and this overlay has already been in the
     - way twice (see the component comment below). -->
    <button
      type="button"
      class="visualizer-debug-overlay__help"
      :aria-expanded="showLegend"
      :title="showLegend ? 'Hide what these mean' : 'What do these mean?'"
      @click="showLegend = !showLegend"
    >
      {{ showLegend ? '×' : '?' }}
    </button>
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

    <dl v-if="showLegend" class="visualizer-debug-overlay__legend">
      <dt>Visualizer</dt>
      <dd>Position the bars are being drawn for.</dd>
      <dt>Cast</dt>
      <dd>Position the cast clock reports for that same moment.</dd>
      <dt>Δ</dt>
      <dd>
        The two subtracted. Holding still is what matters: a value that keeps growing means the two
        clocks run at different speeds. A large but <em>constant</em> offset is a calibration gap
        instead — both sides are re-based to the same zero, so it should settle near it. Red past
        0.75s. It says the clocks disagree, not which one is wrong.
      </dd>
      <template v-if="debug.lead">
        <dt>Lead</dt>
        <dd>
          Sonos radio only: how far ahead of the speaker the relay runs.
          <em>measured</em> = a real reading landed, <em>guessed</em> = still the fixed fallback.
        </dd>
      </template>
    </dl>
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
      // Per visit, not remembered: whoever opens this is reading it once to
      // learn what the four lines are, and wants the numbers unobstructed
      // afterwards.
      showLegend: false,
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
/* Wide enough for the legend's prose when it is open, but only then — the
 * numbers themselves are short, and a permanently wide box sits over more
 * of the artwork than it needs to. */
.visualizer-debug-overlay:has(.visualizer-debug-overlay__legend) {
  max-width: 320px;
}

/* Sits in the top corner beside the first reading rather than above it, so
 * opening the legend does not push the numbers down the screen. */
.visualizer-debug-overlay__help {
  float: right;
  margin-left: 10px;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.12);
  color: inherit;
  font: inherit;
  line-height: 16px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.visualizer-debug-overlay__help:hover {
  background: rgba(255, 255, 255, 0.22);
}

.visualizer-debug-overlay__legend {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.18);
  /* Prose, unlike the readings above it, which are figures kept in a
   * monospace column so they line up as they tick. `inherit` would have
   * taken that monospace with it. */
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    Roboto,
    sans-serif;
  font-size: 11px;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.75);
}

.visualizer-debug-overlay__legend dt {
  font-weight: 600;
  color: rgba(255, 255, 255, 0.92);
}

.visualizer-debug-overlay__legend dd {
  margin: 0 0 6px;
}

.visualizer-debug-overlay__legend dd:last-child {
  margin-bottom: 0;
}

/* The keywords the Lead line actually prints, coloured as it prints them.
 * Plain italics elsewhere in the legend: <em> there is emphasis in a
 * sentence, not a value being quoted. */
.visualizer-debug-overlay__legend dd:last-child em {
  font-style: normal;
  color: rgba(140, 255, 170, 0.95);
}

/* Fixed dark backdrop rather than a theme-aware one on purpose: this can
   sit over a blurred artwork backdrop or the visualizer's own colored
   bars, not over the app's ordinary surface, so it needs to stay readable
   regardless of the current theme rather than blending into it. */
.visualizer-debug-overlay {
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba(255, 255, 255, 0.92);
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  user-select: text;
  min-width: 200px;
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
