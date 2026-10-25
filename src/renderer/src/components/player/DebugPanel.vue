<template>
  <section class="debug-panel" :class="{ 'debug-panel--legend': showLegend }">
    <header class="debug-panel__head">
      <span class="debug-panel__title eyebrow-label">{{ title }}</span>
      <span v-if="meta" class="debug-panel__meta">{{ meta }}</span>
      <v-btn
        v-if="$slots.legend"
        class="debug-panel__help"
        icon
        size="x-small"
        variant="text"
        density="comfortable"
        :aria-expanded="showLegend"
        :title="showLegend ? 'Hide what these mean' : 'What do these mean?'"
        @click="showLegend = !showLegend"
      >
        <v-icon size="16">{{ showLegend ? 'mdi-close' : 'mdi-help-circle-outline' }}</v-icon>
      </v-btn>
      <v-btn
        class="debug-panel__copy"
        icon
        size="x-small"
        variant="text"
        density="comfortable"
        :title="copied ? 'Copied' : 'Copy this reading'"
        @click="copyReading"
      >
        <v-icon size="16">{{ copied ? 'mdi-check' : 'mdi-content-copy' }}</v-icon>
      </v-btn>
    </header>

    <div class="debug-panel__scroll">
      <slot />

      <dl v-if="showLegend" class="debug-panel__legend">
        <slot name="legend" />
      </dl>
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'

/**
 * The frame both of Now Playing's debug overlays sit in - the visualizer's
 * sync readout and the cast stream's - so they read as one instrument where
 * they stack in the same corner, and cannot drift apart again.
 *
 * Not run through $t(), like everything inside it: a diagnostic for whoever
 * turned the log level to DEBUG/TRACE to chase something, not user-facing
 * copy.
 */
export default {
  name: 'DebugPanel',
  props: {
    title: { type: String, required: true },
    /** A short reading beside the title, e.g. where the track is. */
    meta: { type: String as PropType<string | null>, default: null },
    /** The reading as text, in the order and wording it is shown in. */
    copyText: { type: Function as PropType<() => string>, required: true },
  },
  data() {
    return {
      // A legend rather than a tooltip per reading: the numbers are read
      // against each other while something plays, so what each means has to
      // be on screen with all of them. Folded away by default, per visit -
      // it is prose over the artwork, and whoever opens it reads it once.
      showLegend: false,
      copied: false,
      copiedTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  },
  beforeUnmount() {
    clearTimeout(this.copiedTimer)
  },
  methods: {
    /** One timestamped snapshot. The numbers change faster than a pointer
     * can select them (reported 2026-09-07), and the time is what lines a
     * pasted reading up against connect's log. navigator.clipboard is
     * absent outside a secure context - the throw comes from the property
     * access, hence try/catch rather than a promise chain; the readings
     * stay on screen either way, so a failure is only logged. */
    async copyReading(): Promise<void> {
      const at = new Date().toLocaleTimeString()
      try {
        await navigator.clipboard.writeText(`${this.title} @ ${at}\n${this.copyText()}`)
        clearTimeout(this.copiedTimer)
        this.copied = true
        this.copiedTimer = setTimeout(() => {
          this.copied = false
        }, 2000)
      } catch (error) {
        console.error('[debug-panel] Failed to copy the reading:', error)
      }
    },
  },
}
</script>

<style scoped>
/* Dark whatever the theme, on purpose: this sits over the artwork backdrop
 * or the visualizer's bars, never over the app's own surface, so it has to
 * stay readable on any picture rather than blend into a light theme. */
/* A column that can shrink below its content: where it sits (Now Playing's
 * debug corner) caps the height, and everything under the head then
 * scrolls instead of running out of the window. */
.debug-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  width: max-content;
  min-width: 240px;
  max-width: 340px;
  padding: 8px 6px 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(8, 9, 14, 0.72);
  backdrop-filter: blur(14px) saturate(140%);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  color: rgba(255, 255, 255, 0.92);
  user-select: text;
}

/* Wide enough for the legend's prose only while it is open - the readings
 * are short, and a permanently wide box covers more artwork than needed. */
.debug-panel--legend {
  max-width: 380px;
}

.debug-panel__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
}

.debug-panel__title {
  flex: 1 1 auto;
  white-space: nowrap;
}

.debug-panel__meta {
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.6);
  white-space: nowrap;
}

.debug-panel__help,
.debug-panel__copy {
  flex: none;
  color: rgba(255, 255, 255, 0.7);
}

.debug-panel__scroll {
  margin-top: 6px;
  padding-right: 6px;
  overflow-y: auto;
}

.debug-panel__legend {
  margin: 10px 0 0;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  font-size: 11px;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.72);
}

.debug-panel__legend :slotted(dt) {
  font-weight: 600;
  color: rgba(255, 255, 255, 0.92);
}

.debug-panel__legend :slotted(dd) {
  margin: 0 0 6px;
}

.debug-panel__legend :slotted(dd:last-child) {
  margin-bottom: 0;
}

/* A keyword the readings print, quoted as they print it. */
.debug-panel__legend :slotted(dd code) {
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  font-size: 10.5px;
  color: rgba(255, 255, 255, 0.92);
}
</style>
