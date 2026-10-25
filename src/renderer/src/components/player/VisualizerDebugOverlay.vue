<template>
  <DebugPanel
    v-if="debugSyncEnabled && debug"
    class="visualizer-debug-overlay"
    title="Visualizer sync"
    :copy-text="readingText"
  >
    <DebugReadings :rows="rows" />

    <template #legend>
      <dt>Visualizer</dt>
      <dd>Position the bars are being drawn for.</dd>
      <dt>Cast</dt>
      <dd>Position the cast clock reports for that same moment.</dd>
      <dt>Δ</dt>
      <dd>
        The two subtracted. Holding still is what matters: a value that keeps growing means the two
        clocks run at different speeds. A large but constant offset is a calibration gap instead —
        both sides are re-based to the same zero, so it should settle near it. Red past 0.75s. It
        says the clocks disagree, not which one is wrong.
      </dd>
      <template v-if="debug.lead">
        <dt>Lead</dt>
        <dd>
          Sonos radio only: how far ahead of the speaker the relay runs. <code>measured</code> = a
          real reading landed, <code>guessed</code> = still the fixed fallback.
        </dd>
      </template>
    </template>
  </DebugPanel>
</template>

<script lang="ts">
import { getLogLevel } from '@/services/connect/logLevel'
import type { VisualizerFrame } from '@/services/connect/types'
import DebugPanel from './DebugPanel.vue'
import DebugReadings, { readingsText, type DebugReading } from './DebugReadings.vue'

// Above this the delta is flagged: a difference this size is audible, not
// a rounding curiosity.
const DELTA_OFF_SECONDS = 0.75

// The visualizer's 'cast'-mode sync debug readout — its own component,
// positioned absolutely by NowPlayingPresentation.vue rather than drawn
// inside the bars, after an earlier version that lived there either sat on
// top of the bars (covering them) or took real flex space away from them
// (visibly compressing them) — reported live 2026-09-05, twice, once for
// each layout tried. `debug` is simply whatever the latest frame of
// NowPlayingView's own visualizer stream carried, not fetched independently
// here — a second GET /visualizer subscription would mean a second reader
// draining the exact same, single-consumer frames queue
// (core/audio_analysis.py's AudioAnalyzer.frames), splitting frames between
// the two connections and starving the actual bars of some of them.
export default {
  name: 'VisualizerDebugOverlay',
  components: { DebugPanel, DebugReadings },
  props: {
    // The latest cast frame's debug payload, handed through the Now
    // Playing source — null whenever nothing has arrived yet, or 'cast'
    // mode isn't running at all right now.
    debug: {
      type: Object as () => VisualizerFrame['debug'] | null,
      default: null,
    },
  },
  data() {
    return {
      // Whether the account's backend log level is DEBUG/TRACE, fetched once
      // at mount: this gates a diagnostic, not something that has to follow
      // Settings being changed in another window mid-session.
      debugSyncEnabled: false,
    }
  },
  computed: {
    // How far apart the visualizer's own clock and the cast clock read,
    // both re-based to the same zero by the backend (see VisualizerFrame).
    // A small, steady value is healthy (SSE/render jitter); a large or
    // growing one is the sync bug this exists to catch. Flagging it is not
    // a verdict on which clock is wrong - core/playback_clock.py's resync
    // or core/visualizer_feed.py's own - only that the two disagree.
    debugDelta(): number {
      if (!this.debug) return 0
      return this.debug.visualizer - this.debug.cast
    },
    rows(): DebugReading[] {
      const debug = this.debug
      if (!debug) return []
      const delta = this.debugDelta
      const rows: DebugReading[] = [
        { label: 'Visualizer', value: `${debug.visualizer.toFixed(2)}s` },
        { label: 'Cast', value: `${debug.cast.toFixed(2)}s` },
        {
          label: 'Δ',
          // The sign is part of the reading: which clock is ahead is the
          // whole question.
          value: `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}s`,
          tone: Math.abs(delta) >= DELTA_OFF_SECONDS ? 'bad' : 'good',
        },
      ]
      // Radio-relayed Sonos only — see VisualizerFrame on why the delta
      // cannot tell the fixed guess from a real measurement without it.
      if (debug.lead) {
        rows.push({
          label: 'Lead',
          value: `${debug.lead.seconds.toFixed(2)}s (${debug.lead.measured ? 'measured' : 'guessed'})`,
          tone: debug.lead.measured ? 'good' : 'warn',
        })
      }
      return rows
    },
  },
  mounted() {
    // Best-effort: a failed GET /log-level leaves the overlay off, same as
    // for anyone not chasing a sync bug in the first place.
    getLogLevel()
      .then(({ level }) => {
        this.debugSyncEnabled = level === 'DEBUG' || level === 'TRACE'
      })
      .catch(() => {})
  },
  methods: {
    readingText(): string {
      return readingsText(this.rows)
    },
  },
}
</script>
