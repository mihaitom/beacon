<template>
  <!-- A preset's shape at a glance, next to its name. -->
  <svg class="eq-mini" viewBox="0 0 56 22" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" x2="56" y1="11" y2="11" class="eq-mini__zero" />
    <path class="eq-mini__curve" :d="path" />
  </svg>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { logPosition, responseCurve } from '@/services/equalizer'

const WIDTH = 56
const HEIGHT = 22
const POINTS = 48
// Smaller than the graph's range: the presets stay within about ±8 dB, and
// at this size a full ±15 would leave them all looking flat.
const RANGE_DB = 9

export default {
  name: 'EqualizerMiniCurve',
  props: {
    gains: { type: Array as PropType<readonly number[]>, required: true },
  },
  computed: {
    path(): string {
      const half = HEIGHT / 2 - 2
      return responseCurve(this.gains, POINTS)
        .map(({ frequency, db }, i) => {
          const x = logPosition(frequency) * WIDTH
          const y = HEIGHT / 2 - (Math.max(-RANGE_DB, Math.min(RANGE_DB, db)) / RANGE_DB) * half
          return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join('')
    },
  },
}
</script>

<style scoped>
.eq-mini {
  width: 56px;
  height: 22px;
  flex: none;
}

.eq-mini__zero {
  stroke: rgba(var(--v-theme-on-surface), 0.15);
  vector-effect: non-scaling-stroke;
}

.eq-mini__curve {
  fill: none;
  stroke: rgb(var(--v-theme-primary));
  stroke-width: 1.6;
  vector-effect: non-scaling-stroke;
}
</style>
