<template>
  <!-- The lights of the picked area, playing a made-up song in the chosen
     - style (stagePreview.ts). Decorative: the choices next to it say
     - everything in words. Dimmed, not dark, while the lights are switched
     - off - it is there to choose a style by, which is often done first. -->
  <div class="lights-stage" :class="{ 'lights-stage--off': !on }" aria-hidden="true">
    <div v-for="n in count" :key="n" ref="lamp" class="lights-stage__lamp" />
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { LightsStyle } from '@/services/connect/lights'
import { previewFrame, type Rgb } from '@/services/lights/stagePreview'

// The preview is meant to be looked at for a few seconds while choosing;
// a room with more lights than this would only shrink every one of them.
const MAX_LAMPS = 6
// The still frame shown with reduced motion: just after a beat, so the
// style's character (a hit, the chase's light on) is still visible.
const STILL_AT_SECONDS = 4.05

export default {
  name: 'LightsStage',
  props: {
    lights: { type: Number, default: 2 },
    lightStyle: { type: String as PropType<LightsStyle>, default: 'pulse' },
    palette: { type: Array as PropType<Rgb[]>, required: true },
    /** 0-1. */
    brightness: { type: Number, default: 1 },
    /** Every light its own colour, turning round the wheel from the
     * palette's first. */
    rotate: { type: Boolean, default: false },
    on: { type: Boolean, default: true },
  },
  data() {
    return { frameId: 0, startedAt: 0 }
  },
  computed: {
    count(): number {
      return Math.max(1, Math.min(MAX_LAMPS, this.lights))
    },
  },
  watch: {
    // Redraws the still frame when a choice changes under reduced motion.
    lightStyle: 'drawStill',
    palette: 'drawStill',
    brightness: 'drawStill',
    rotate: 'drawStill',
    count() {
      void this.$nextTick(() => this.drawStill())
    },
  },
  mounted() {
    this.startedAt = performance.now()
    if (this.reducedMotion()) this.drawStill()
    else this.frameId = requestAnimationFrame(this.loop)
  },
  unmounted() {
    cancelAnimationFrame(this.frameId)
  },
  methods: {
    reducedMotion(): boolean {
      return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    },
    loop(now: number) {
      // Asked for first, so one frame that fails to draw does not end the
      // animation for good.
      this.frameId = requestAnimationFrame(this.loop)
      this.draw((now - this.startedAt) / 1000)
    },
    drawStill() {
      if (this.reducedMotion()) this.draw(STILL_AT_SECONDS)
    },
    draw(t: number) {
      const lamps = ((this.$refs.lamp as (HTMLElement | null)[] | undefined) ?? []).filter(
        (lamp): lamp is HTMLElement => !!lamp,
      )
      if (!this.palette.length || !lamps.length) return
      const frame = previewFrame(
        t,
        this.lightStyle,
        this.palette,
        lamps.length,
        this.brightness,
        this.rotate,
      )
      lamps.forEach((lamp, i) => {
        const { colour, level } = frame[i]!
        const lit = colour.map((c) => Math.round(c * level)).join(', ')
        lamp.style.setProperty('--lamp', `rgb(${lit})`)
        lamp.style.setProperty('--glow', `rgba(${colour.join(', ')}, ${Math.min(1, level * 1.1)})`)
      })
    },
  },
}
</script>

<style scoped>
/* Always a dark room, on every theme: the lights are the point, and a
 * light theme's page behind them would wash every colour out. */
.lights-stage {
  height: 128px;
  border-radius: 12px;
  background: #07080c;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: space-evenly;
}

.lights-stage__lamp {
  position: relative;
  z-index: 0;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--lamp, #222);
}

.lights-stage__lamp::after {
  content: '';
  position: absolute;
  inset: -46px;
  z-index: -1;
  border-radius: 50%;
  background: radial-gradient(circle, var(--glow, transparent) 0%, transparent 65%);
}

.lights-stage--off .lights-stage__lamp {
  opacity: 0.35;
}
</style>
