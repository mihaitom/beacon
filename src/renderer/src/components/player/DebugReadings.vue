<template>
  <dl class="debug-readings">
    <template v-for="row in rows" :key="row.label">
      <dt class="debug-readings__label">{{ row.label }}</dt>
      <dd
        class="debug-readings__value"
        :class="row.tone ? `debug-readings__value--${row.tone}` : null"
      >
        {{ row.value }}
      </dd>
    </template>
  </dl>
</template>

<script lang="ts">
import type { PropType } from 'vue'

export interface DebugReading {
  label: string
  value: string
  /** Coloured only where the reading is a verdict worth catching the eye. */
  tone?: 'good' | 'warn' | 'bad'
}

/** Debug readings as a label column and a value column, for DebugPanel. */
export default {
  name: 'DebugReadings',
  props: {
    rows: { type: Array as PropType<DebugReading[]>, required: true },
  },
}

/** The same readings as text, for DebugPanel's copy. */
export function readingsText(rows: DebugReading[], indent = ''): string {
  return rows.map((row) => `${indent}${row.label}: ${row.value}`).join('\n')
}
</script>

<style scoped>
.debug-readings {
  display: grid;
  /* A floor on the label column so the values of several speakers' blocks,
   * each its own grid, still line up under one another. */
  grid-template-columns: minmax(4.75em, max-content) minmax(0, 1fr);
  column-gap: 12px;
  row-gap: 2px;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}

.debug-readings__label {
  color: rgba(255, 255, 255, 0.55);
}

/* Monospaced figures, so a value that ticks every second holds its column
 * instead of jittering sideways. */
.debug-readings__value {
  margin: 0;
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

/* The theme's state colours, not literal ones: the panel sits inside Now
 * Playing's night theme, whose states are drawn for a dark ground. */
.debug-readings__value--good {
  color: rgb(var(--v-theme-success));
}

.debug-readings__value--warn {
  color: rgb(var(--v-theme-warning));
}

.debug-readings__value--bad {
  color: rgb(var(--v-theme-error));
  font-weight: 600;
}
</style>
