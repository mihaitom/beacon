<template>
  <canvas ref="canvasEl" class="audio-visualizer" />
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { BAR_COUNT } from '@/services/visualizerBands'

// Fraction of the canvas height bars settle to when there's no signal to
// show (paused, or a 'cast' connection that hasn't produced a frame yet) —
// a resting flat line rather than nothing, so it still reads as "this is a
// visualizer" at rest.
const IDLE_HEIGHT = 0
/** The bars themselves: canvas, smoothing and painting, fed by whoever
 * knows what is playing - AudioVisualizer for the app, the party guest
 * page with the frames connect hands it. Knows no store, so the guest
 * page doesn't carry the app's playback along with it. */
export default {
  name: 'VisualizerBars',
  props: {
    // False while the parent is showing this component only to let it
    // animate out — the bars settle all the way to 0 instead of resting.
    active: {
      type: Boolean,
      default: true,
    },
    /** An "r, g, b" triplet - see AudioVisualizer's own color prop. */
    color: {
      type: String,
      default: '245, 169, 78',
    },
    /** The target height (0..1) of each of BAR_COUNT bars right now, read
     * once per rendered frame; null for none (the bars settle). */
    sample: {
      type: Function as PropType<() => number[] | null>,
      required: true,
    },
    /** How far each bar moves toward its target per rendered frame. */
    smoothing: {
      type: Number,
      default: 0.3,
    },
  },
  data() {
    return {
      heights: Array.from({ length: BAR_COUNT }, () => IDLE_HEIGHT) as number[],
      rafId: null as number | null,
      resizeObserver: null as ResizeObserver | null,
      // Set once at mount — no need to react to the setting changing
      // mid-session for a decorative element like this.
      reducedMotion: false,
    }
  },
  mounted() {
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas())
    this.resizeObserver.observe(this.$el)
    this.resizeCanvas()
    if (this.reducedMotion) {
      // Bars would otherwise render one static frame and then never move
      // again (see the removed renderFrame() call here and in
      // resizeCanvas()) — with no ongoing animation, that reads as a broken
      // visualizer rather than a deliberately motion-free one, so skip the
      // paint entirely and say why instead.
      this.$emitter.emit('toast', {
        level: 'information',
        title: this.$t('nowPlaying.reducedMotionToastTitle'),
        message: this.$t('nowPlaying.reducedMotionToastMessage'),
      })
    } else {
      this.rafId = requestAnimationFrame(this.draw)
    }
  },
  beforeUnmount() {
    if (this.rafId != null) cancelAnimationFrame(this.rafId)
    this.resizeObserver?.disconnect()
  },
  methods: {
    resizeCanvas() {
      const canvas = this.$refs.canvasEl as HTMLCanvasElement | undefined
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(rect.width * ratio))
      canvas.height = Math.max(1, Math.round(rect.height * ratio))
      // Setting either dimension wipes the canvas, and this runs after the
      // frame's own draw() but before it is painted - so every frame of a
      // window drag was painted empty, which reads as flicker. Repainting
      // here fills it again in the same frame. Not while reduced motion is
      // on: nothing has ever painted then (see mounted()), and one static
      // frame appearing on resize would be worse than none.
      if (!this.reducedMotion) this.renderFrame()
    },
    draw() {
      this.rafId = requestAnimationFrame(this.draw)
      this.renderFrame()
    },
    renderFrame() {
      const canvas = this.$refs.canvasEl as HTMLCanvasElement | undefined
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return

      const targets = this.sample()
      // Inactive (toggled off, or nothing playable) settles all the way to
      // 0 instead of the normal idle resting line — see the `active` prop.
      const floor = this.active ? IDLE_HEIGHT : 0
      const smoothing = this.smoothing
      for (let i = 0; i < BAR_COUNT; i++) {
        const target = Math.max(floor, targets?.[i] ?? floor)
        // heights is always exactly BAR_COUNT long (see data()) — i is
        // always in bounds here.
        this.heights[i] = this.heights[i]! + (target - this.heights[i]!) * smoothing
      }

      this.paint(ctx, canvas.width, canvas.height)
    },
    paint(ctx: CanvasRenderingContext2D, width: number, height: number) {
      ctx.clearRect(0, 0, width, height)
      if (width <= 0 || height <= 0) return

      const gap = Math.max(1, width * 0.004)
      const barWidth = (width - gap * (BAR_COUNT - 1)) / BAR_COUNT
      const gradient = ctx.createLinearGradient(0, height, 0, 0)
      gradient.addColorStop(0, `rgba(${this.color}, 1)`)
      gradient.addColorStop(1, `rgba(${this.color}, 0.8)`)
      // A soft dark shadow under the bars, so they stay legible over a
      // bright artist background rather than washing out into it.
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
      ctx.shadowBlur = 8
      ctx.shadowOffsetY = 1
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
