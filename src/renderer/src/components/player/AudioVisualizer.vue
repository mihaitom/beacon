<template>
  <visualizer-bars :active="active" :color="color" :sample="sampleTargets" :smoothing="smoothing" />
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { getAudioEngine } from '@/services/audioEngine'
import { VisualizerEventSource } from '@/services/connect/visualizer'
import type { VisualizerFrame } from '@/services/connect/types'
import { BAR_COUNT, MAX_FREQ_HZ, MIN_FREQ_HZ, resampleBands } from '@/services/visualizerBands'
import VisualizerBars from './VisualizerBars.vue'

// How far each bar moves toward its target height per rendered frame —
// lower is smoother/laggier, higher tracks the signal more tightly.
// Applied both rising into real data and falling back to IDLE_HEIGHT/0, so
// pausing (or toggling off) settles the bars instead of snapping them.
// Lowered from 0.5 (in both modes, see SMOOTHING_CAST below) — that read
// as visibly jittery, chasing every small frame-to-frame fluctuation in
// the underlying FFT data almost fully within a single rendered frame
// instead of settling into a steadier motion.
const SMOOTHING_LOCAL = 0.3
// 'local' gets a fresh real value every rendered frame (~60Hz, straight
// off the Web Audio analyser) — SMOOTHING_LOCAL alone already looks tight
// there. 'cast' only gets a new real value roughly every ~23ms (backend's
// own hop size, see audio_analysis.py's _FRAME_SECONDS) — with too low a
// constant, each bar was still chasing the *previous* target when the
// next one arrived, compounding into a persistent, hard-to-pin-down
// "always a bit behind" feel even though the backend's own release timing
// checked out exactly on schedule. Kept equal to SMOOTHING_LOCAL rather
// than higher, though: at this update rate (close to the render rate) a
// stronger pull here just traded that laggy feel for the same jitteriness
// SMOOTHING_LOCAL's own drop was fixing.
const SMOOTHING_CAST = 0.3

export default {
  name: 'AudioVisualizer',
  components: { VisualizerBars },
  props: {
    // False while the parent is showing this component only to let it
    // animate out (visualizer toggled off, or nothing playable anymore) —
    // see NowPlayingView.vue's visualizerMounted/visualizerActive split.
    // Every bar's target becomes 0 instead of IDLE_HEIGHT while inactive,
    // so it settles all the way down through the same smoothing this
    // already does for everything else, rather than just vanishing.
    active: {
      type: Boolean,
      default: true,
    },
    /** The scene's dominant colour as an "r, g, b" triplet — the same one
     * NowPlayingView's ambient wash and glow use, so the bars read as part
     * of the backdrop rather than as a fixed amber element on top of it.
     * Falls back to the app's amber when nothing could be extracted. */
    color: {
      type: String,
      default: '245, 169, 78',
    },
  },
  // 'debug-frame': this run's latest debug payload (or null, once 'cast'
  // mode ends) — see VisualizerFrame's own comment for what it carries.
  // Deliberately not rendered here: an earlier version drew it as a canvas
  // sibling inside this component, which either sat on top of the bars
  // (covering them) or took real layout space away from them (visibly
  // compressing them, reported live 2026-09-05) no matter how it was laid
  // out — this component's own box is exactly the bars' box, with nothing
  // to spare. NowPlayingView.vue owns VisualizerDebugOverlay.vue instead,
  // positioned absolutely in its *own* layout, decoupled from this
  // component's size entirely.
  emits: ['debug-frame'],
  data() {
    return {
      frequencyData: null as Uint8Array<ArrayBuffer> | null,
      visualizerEvents: null as VisualizerEventSource | null,
      // Latest frame from GET /visualizer (connect/core/audio_analysis.py)
      // — null until the first one arrives, or once 'cast' mode ends.
      castBands: null as number[] | null,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    // 'local' has a real <audio> element to tap (see services/audioEngine.ts);
    // 'cast' has real data too, but from the backend instead (see
    // services/connect/visualizer.ts) — NowPlayingView.vue only mounts this
    // component at all when casting to a target that can actually produce
    // that data (not radio — see its own visualizerAvailable for why,
    // deliberately, even though the backend can technically decode one
    // now), so by the time this component exists, 'cast' here is always
    // meaningful.
    mode(): 'local' | 'cast' | 'idle' {
      if (!this.active) return 'idle' // fading out — no need for real data
      if (!this.playbackStore.isPlaying) return 'idle'
      return this.playbackStore.isCasting ? 'cast' : 'local'
    },
    smoothing(): number {
      return this.mode === 'cast' ? SMOOTHING_CAST : SMOOTHING_LOCAL
    },
  },
  watch: {
    mode: {
      immediate: true,
      handler(mode: 'local' | 'cast' | 'idle') {
        if (mode === 'cast') this.startVisualizerEvents()
        else this.stopVisualizerEvents()
      },
    },
  },
  beforeUnmount() {
    this.stopVisualizerEvents()
  },
  methods: {
    startVisualizerEvents() {
      if (this.visualizerEvents) return
      const auth = useAuthStore()
      this.visualizerEvents = new VisualizerEventSource(
        auth.apiUrl,
        auth.connectToken,
        auth.sessionId,
      )
      this.visualizerEvents.onFrame = (frame: VisualizerFrame) => {
        this.castBands = frame.bands
        this.$emit('debug-frame', frame.debug ?? null)
      }
      this.visualizerEvents.start()
    },
    stopVisualizerEvents() {
      this.visualizerEvents?.stop()
      this.visualizerEvents = null
      this.castBands = null
      this.$emit('debug-frame', null)
    },
    /** What VisualizerBars reads every frame. */
    sampleTargets(): number[] | null {
      return this.mode === 'local' ? this.sampleFrequencies() : resampleBands(this.castBands)
    },
    // Raw FFT bins are linearly spaced in frequency, but pitch/perceived
    // "spread" of musical content is logarithmic — a linear bin mapping
    // devotes the same number of bars to the octave between 11 and 22kHz
    // (usually near-silent) as to the one between 20 and 40Hz (a single
    // bass note's entire range), leaving most of the low end crammed into
    // one or two bars. Each bar instead covers its own logarithmically-
    // spaced frequency slice (MIN_FREQ_HZ..MAX_FREQ_HZ) and averages
    // whatever raw bins fall inside it — same approach as
    // connect/core/audio_analysis.py's analyze_pcm() for 'cast' mode, so
    // both modes read the same regardless of which is active.
    sampleFrequencies(): number[] | null {
      let analyser: AnalyserNode
      try {
        analyser = getAudioEngine().getAnalyser()
      } catch (error) {
        console.error('[audio-visualizer] Web Audio analyser unavailable:', error)
        return null
      }
      if (!this.frequencyData || this.frequencyData.length !== analyser.frequencyBinCount) {
        this.frequencyData = new Uint8Array(analyser.frequencyBinCount)
      }
      analyser.getByteFrequencyData(this.frequencyData)
      const binHz = analyser.context.sampleRate / analyser.fftSize
      const bins = this.frequencyData
      const ratio = MAX_FREQ_HZ / MIN_FREQ_HZ
      const heights = Array.from<number>({ length: BAR_COUNT })
      for (let i = 0; i < BAR_COUNT; i++) {
        const loFreq = MIN_FREQ_HZ * ratio ** (i / BAR_COUNT)
        const hiFreq = MIN_FREQ_HZ * ratio ** ((i + 1) / BAR_COUNT)
        const loBin = Math.max(0, Math.floor(loFreq / binHz))
        const hiBin = Math.min(bins.length, Math.max(loBin + 1, Math.ceil(hiFreq / binHz)))
        let sum = 0
        for (let bin = loBin; bin < hiBin; bin++) sum += bins[bin] ?? 0
        heights[i] = sum / (hiBin - loBin) / 255
      }
      return heights
    },
  },
}
</script>
