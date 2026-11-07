<template>
  <!-- A preset's shape at a glance, next to its name. -->
  <svg class="eq-mini" viewBox="0 0 56 22" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" x2="56" y1="11" y2="11" class="eq-mini__zero" />
    <path class="eq-mini__curve" :d="path" />
  </svg>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { EQ_FREQUENCIES, logPosition, smoothPath } from '@/services/equalizer'

const WIDTH = 56
const HEIGHT = 22
// Smaller than the graph's range: the presets stay within ±6 dB, and at
// this size a full ±15 would leave them all looking flat.
const RANGE_DB = 9

export default {
  name: 'EqualizerMiniCurve',
  props: {
    gains: { type: Array as PropType<readonly number[]>, required: true },
  },
  computed: {
    path(): string {
      const half = HEIGHT / 2 - 2
      const points = EQ_FREQUENCIES.map((frequency, i) => {
        const db = Math.max(-RANGE_DB, Math.min(RANGE_DB, this.gains[i] ?? 0))
        return [logPosition(frequency) * WIDTH, HEIGHT / 2 - (db / RANGE_DB) * half] as [
          number,
          number,
        ]
      })
      return smoothPath(points, WIDTH)
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
