<template>
  <!-- Where each lamp sits on the colour wheel in the rotation, moving on
     - with the song's beats (stagePreview.ts) - the same clock as
     - the stage above, so a dot moves when the lamps light. Decorative: the
     - hint beside it says it in words. -->
  <div class="colour-wheel" aria-hidden="true">
    <div class="colour-wheel__ring" />
    <span v-for="n in count" :key="n" ref="dot" class="colour-wheel__dot" />
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import {
  MADE_UP_SONG,
  hueOf,
  previewTime,
  previewTurn,
  rgbToHex,
  rotation,
  type PreviewSong,
  type Rgb,
} from '@/services/lights/stagePreview'

// The stage shows at most this many lamps too (LightsStage.vue).
const MAX_DOTS = 6
// Matches the ring's size in the style block: where the dots run.
const RADIUS_PX = 35
const CENTRE_PX = 42
// The still frame with reduced motion, as LightsStage's.
const STILL_AT_SECONDS = 4.05

export default {
  name: 'LightsColourWheel',
  props: {
    /** Where the rotation starts: the picture's first colour, or the
     * theme's. */
    start: { type: Array as unknown as PropType<Rgb>, required: true },
    lights: { type: Number, default: 2 },
    song: { type: Object as PropType<PreviewSong>, default: () => MADE_UP_SONG },
    /** Seconds into `song` at a requestAnimationFrame time. */
    clock: { type: Function as PropType<(now: number) => number>, default: previewTime },
  },
  data() {
    return { frameId: 0 }
  },
  computed: {
    count(): number {
      return Math.max(1, Math.min(MAX_DOTS, this.lights))
    },
  },
  watch: {
    start: 'drawStill',
    count() {
      void this.$nextTick(() => this.drawStill())
    },
  },
  mounted() {
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
      this.frameId = requestAnimationFrame(this.loop)
      this.draw(this.clock(now), this.song)
    },
    drawStill() {
      if (this.reducedMotion()) this.draw(STILL_AT_SECONDS, MADE_UP_SONG)
    },
    draw(t: number, song: PreviewSong) {
      const dots = ((this.$refs.dot as (HTMLElement | null)[] | undefined) ?? []).filter(
        (dot): dot is HTMLElement => !!dot,
      )
      const colours = rotation(this.start, dots.length, previewTurn(song, t))
      dots.forEach((dot, i) => {
        // Clockwise from the top, as the conic gradient runs.
        const angle = hueOf(colours[i]!) * 2 * Math.PI - Math.PI / 2
        dot.style.left = `${CENTRE_PX + RADIUS_PX * Math.cos(angle)}px`
        dot.style.top = `${CENTRE_PX + RADIUS_PX * Math.sin(angle)}px`
        dot.style.background = rgbToHex(colours[i]!)
      })
    },
  },
}
</script>

<style scoped>
.colour-wheel {
  position: relative;
  flex: none;
  width: 84px;
  height: 84px;
}

/* Only full colours: a lamp shows a pale one as white, so the wheel has no
 * paler middle. */
.colour-wheel__ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(#ff3b3b, #ffd23b, #3bff6b, #3bd8ff, #3b5bff, #d43bff, #ff3b3b);
  mask: radial-gradient(circle, transparent 29px, #000 30px);
}

/* Drawn in white whatever the theme: they sit on the wheel's colours. */
.colour-wheel__dot {
  position: absolute;
  width: 14px;
  height: 14px;
  margin: -7px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
}
</style>
