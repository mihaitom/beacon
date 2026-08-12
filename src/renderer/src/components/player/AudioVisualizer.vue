<template>
  <canvas ref="canvasEl" class="audio-visualizer" />
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { getAudioEngine } from '@/services/audioEngine'
import { VisualizerEventSource } from '@/services/connect/visualizer'

const BAR_COUNT = 56
// Fraction of the canvas height bars settle to when there's no signal to
// show (paused, or a 'cast' connection that hasn't produced a frame yet) —
// a resting flat line rather than nothing, so it still reads as "this is a
// visualizer" at rest.
const IDLE_HEIGHT = 0.035
// How far each bar moves toward its target height per rendered frame —
// lower is smoother/laggier, higher tracks the signal more tightly.
// Applied both rising into real data and falling back to IDLE_HEIGHT/0, so
// pausing (or toggling off) settles the bars instead of snapping them.
const SMOOTHING_LOCAL = 0.35
// 'local' gets a fresh real value every rendered frame (~60Hz, straight
// off the Web Audio analyser) — SMOOTHING_LOCAL alone already looks tight
// there. 'cast' only gets a new real value roughly every ~93ms (backend's
// own FFT frame size, see audio_analysis.py's _FRAME_SECONDS) — with the
// same low constant, each bar was still chasing the *previous* target when
// the next one arrived, compounding into a persistent, hard-to-pin-down
// "always a bit behind" feel even though the backend's own release timing
// checked out exactly on schedule. A stronger pull here means each bar
// actually catches up to its target before the next SSE frame lands.
const SMOOTHING_CAST = 0.35

export default {
  name: 'AudioVisualizer',
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
  },
  data() {
    return {
      heights: new Array(BAR_COUNT).fill(IDLE_HEIGHT) as number[],
      rafId: null as number | null,
      resizeObserver: null as ResizeObserver | null,
      frequencyData: null as Uint8Array<ArrayBuffer> | null,
      visualizerEvents: null as VisualizerEventSource | null,
      // Latest frame from GET /visualizer (connect/core/audio_analysis.py)
      // — null until the first one arrives, or once 'cast' mode ends.
      castBands: null as number[] | null,
      // Set once at mount — no need to react to the setting changing
      // mid-session for a decorative element like this.
      reducedMotion: false,
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
    // that data (not AirPlay/radio — see its own visualizerAvailable), so
    // by the time this component exists, 'cast' here is always meaningful.
    mode(): 'local' | 'cast' | 'idle' {
      if (!this.active) return 'idle' // fading out — no need for real data
      if (!this.playbackStore.isPlaying) return 'idle'
      return this.playbackStore.isCasting ? 'cast' : 'local'
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
  mounted() {
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas())
    this.resizeObserver.observe(this.$el)
    this.resizeCanvas()
    if (this.reducedMotion) {
      this.renderFrame()
    } else {
      this.rafId = requestAnimationFrame(this.draw)
    }
  },
  beforeUnmount() {
    if (this.rafId != null) cancelAnimationFrame(this.rafId)
    this.resizeObserver?.disconnect()
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
      this.visualizerEvents.onFrame = (frame) => {
        this.castBands = frame.bands
      }
      this.visualizerEvents.start()
    },
    stopVisualizerEvents() {
      this.visualizerEvents?.stop()
      this.visualizerEvents = null
      this.castBands = null
    },
    resizeCanvas() {
      const canvas = this.$refs.canvasEl as HTMLCanvasElement | undefined
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(rect.width * ratio))
      canvas.height = Math.max(1, Math.round(rect.height * ratio))
      if (this.reducedMotion) this.renderFrame()
    },
    draw() {
      this.rafId = requestAnimationFrame(this.draw)
      this.renderFrame()
    },
    renderFrame() {
      const canvas = this.$refs.canvasEl as HTMLCanvasElement | undefined
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return

      const targets = this.mode === 'local' ? this.sampleFrequencies() : this.resampleCastBands()
      // Inactive (toggled off, or nothing playable) settles all the way to
      // 0 instead of the normal idle resting line — see the `active` prop.
      const floor = this.active ? IDLE_HEIGHT : 0
      const smoothing = this.mode === 'cast' ? SMOOTHING_CAST : SMOOTHING_LOCAL
      for (let i = 0; i < BAR_COUNT; i++) {
        const target = Math.max(floor, targets?.[i] ?? floor)
        // heights is always exactly BAR_COUNT long (see data()) — i is
        // always in bounds here.
        this.heights[i] = this.heights[i]! + (target - this.heights[i]!) * smoothing
      }

      this.paint(ctx, canvas.width, canvas.height)
    },
    // Byte frequency data isn't evenly perceptually distributed — most of
    // a typical track's energy sits in the lower bins, with the top of
    // the range usually near-silent. Sampling only the lower ~85% avoids
    // spending a third of the bar row on bins that would just sit flat.
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
      const usableBins = Math.floor(analyser.frequencyBinCount * 0.85)
      const heights = new Array<number>(BAR_COUNT)
      for (let i = 0; i < BAR_COUNT; i++) {
        const bin = Math.floor((i / BAR_COUNT) * usableBins)
        heights[i] = (this.frequencyData[bin] ?? 0) / 255
      }
      return heights
    },
    // The backend sends roughly as many bands as this draws bars
    // (_BAND_COUNT in audio_analysis.py) but not necessarily exactly —
    // linear interpolation between the two nearest bands stretches one
    // onto the other smoothly. Nearest-index resampling (tried first)
    // duplicated each band across multiple adjacent bars whenever there
    // were meaningfully fewer bands than bars, which read as neighboring
    // bars visibly moving in lockstep "groups" instead of independently.
    resampleCastBands(): number[] | null {
      const bands = this.castBands
      if (!bands || bands.length === 0) return null
      if (bands.length === 1) return new Array(BAR_COUNT).fill(bands[0])
      const heights = new Array<number>(BAR_COUNT)
      for (let i = 0; i < BAR_COUNT; i++) {
        const position = (i / (BAR_COUNT - 1)) * (bands.length - 1)
        const lower = Math.floor(position)
        const upper = Math.min(bands.length - 1, lower + 1)
        const t = position - lower
        const a = bands[lower] ?? 0
        const b = bands[upper] ?? 0
        heights[i] = a + (b - a) * t
      }
      return heights
    },
    paint(ctx: CanvasRenderingContext2D, width: number, height: number) {
      ctx.clearRect(0, 0, width, height)
      if (width <= 0 || height <= 0) return

      const gap = Math.max(1, width * 0.004)
      const barWidth = (width - gap * (BAR_COUNT - 1)) / BAR_COUNT
      const gradient = ctx.createLinearGradient(0, height, 0, 0)
      gradient.addColorStop(0, 'rgba(245, 169, 78, 0.85)')
      gradient.addColorStop(1, 'rgba(245, 169, 78, 0.25)')
      ctx.fillStyle = gradient

      ctx.beginPath()
      for (let i = 0; i < BAR_COUNT; i++) {
        const barHeight = Math.max(1, Math.min(height, this.heights[i]! * height))
        const x = i * (barWidth + gap)
        const y = height - barHeight
        const radius = Math.min(barWidth / 2, 3)
        ctx.roundRect(x, y, barWidth, barHeight, [radius, radius, 0, 0])
      }
      ctx.fill()
    },
  },
}
</script>

<style scoped>
.audio-visualizer {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
