<template>
  <div class="eq-graph-wrap">
    <!-- The curve is the control: a band is dragged up and down where it
       - sits. Hand-rolled rather than ten v-sliders: Vuetify has no control
       - for points on a shared curve, and its slider loses the drag on a
       - real phone anyway (docs/investigations/phone-and-browser/
       - mobile-volume-slider-ignores-drags.md). Pointer events with
       - `touch-action: none` and pointer capture are what keep a drag here. -->
    <div
      ref="graph"
      class="eq-graph"
      :class="{
        'eq-graph--off': !enabled,
        'eq-graph--disabled': disabled,
        'eq-graph--profile': profile,
      }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="hovered = probeX = null"
      @dblclick="onDoubleClick"
    >
      <svg class="eq-graph__svg" :viewBox="`0 0 ${width} ${height}`" aria-hidden="true">
        <defs>
          <!-- Strongest at the edges, fading towards the 0 dB line: the
             - fill shows how far the curve moved, not a block of colour. -->
          <linearGradient :id="fillId" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" class="eq-graph__stop eq-graph__stop--edge" />
            <stop offset="0.5" class="eq-graph__stop eq-graph__stop--zero" />
            <stop offset="1" class="eq-graph__stop eq-graph__stop--edge" />
          </linearGradient>
        </defs>
        <path v-if="spectrumPath" class="eq-graph__spectrum" :d="spectrumPath" />
        <g class="eq-graph__grid">
          <template v-for="line in dbLines" :key="line.db">
            <line
              x1="0"
              :x2="width"
              :y1="line.y"
              :y2="line.y"
              :class="{ 'eq-graph__zero': line.db === 0 }"
            />
            <!-- No label on the 0 dB line: the curve rests on it. -->
            <text v-if="line.db !== 0" x="6" :y="line.y - 3">{{ line.label }}</text>
          </template>
          <line v-for="x in decadeLines" :key="x" :x1="x" :x2="x" y1="0" :y2="height" />
        </g>
        <path class="eq-graph__area" :d="areaPath" :fill="`url(#${fillId})`" />
        <path class="eq-graph__curve" :d="curvePath" />
      </svg>
      <!-- Each point sits at its own band's gain, not on the summed curve:
         - octave-wide bands overlap, so on the curve a point would move
         - whenever its neighbour does. A profile has no points: it is
         - played as imported, not adjusted here. -->
      <div
        v-for="(frequency, index) in profile ? [] : frequencies"
        :key="frequency"
        class="eq-graph__handle"
        :class="{
          'eq-graph__handle--set': gains[index] !== 0,
          'eq-graph__handle--active': activeIndex === index,
        }"
        :style="{ left: `${bandX(index)}px`, top: `${gainY(gains[index] ?? 0)}px` }"
        role="slider"
        :tabindex="disabled ? -1 : 0"
        :aria-label="bandLabel(frequency)"
        :aria-valuemin="-maxGain"
        :aria-valuemax="maxGain"
        :aria-valuenow="gains[index]"
        :aria-valuetext="`${gainLabel(gains[index])} dB`"
        :aria-disabled="disabled"
        @focus="focused = index"
        @blur="focused = null"
        @keydown="onKeydown(index, $event)"
      />
      <div
        v-if="activeIndex !== null"
        class="eq-graph__tip"
        :style="{ left: `${bandX(activeIndex)}px`, top: `${gainY(gains[activeIndex] ?? 0)}px` }"
      >
        {{ frequencyLabel(frequencies[activeIndex]!) }} Hz · {{ gainLabel(gains[activeIndex]) }} dB
      </div>
      <div
        v-if="probe"
        class="eq-graph__tip"
        :style="{ left: `${probe.x}px`, top: `${probe.y}px` }"
      >
        {{ probe.label }}
      </div>
    </div>
    <div class="eq-graph__freqs text-body-small text-medium-emphasis" aria-hidden="true">
      <template v-for="(frequency, index) in frequencies" :key="frequency">
        <span v-if="labelled[index]" :style="{ left: `${bandX(index)}px` }">
          {{ frequencyLabel(frequency) }}
        </span>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import {
  EQ_FREQUENCIES,
  EQ_MAX_GAIN_DB,
  EQ_STEP_DB,
  responseDb,
  smoothPath,
  type EqualizerBand,
} from '@/services/equalizer'
import { BAR_COUNT, MAX_FREQ_HZ, MIN_FREQ_HZ } from '@/services/visualizerBands'

// The graph runs a little past the audible range on both sides, so the
// 31 Hz and 16 kHz points sit clear of the dB labels and of the edge.
const LOW_HZ = 12
const HIGH_HZ = 24000
// Below this many pixels between two neighbouring bands, only every other
// frequency is labelled - "125" and "250" run into each other on a phone.
const LABEL_SPACING_PX = 36
// The drawing's vertical range: one band's whole range either way, plus a
// little, since neighbouring boosts add up past a single band's.
const RANGE_DB = 15
// Room above +15 and below -15 dB, so a handle at the edge is not cut in half.
const EDGE_PX = 14
const GRID_DB = [-12, -6, 0, 6, 12]
const DECADES_HZ = [100, 1000, 10000]
// How far the spectrum bars reach up the graph at full level: the music is
// the backdrop, the curve the subject.
const SPECTRUM_HEIGHT = 0.6
// A profile's exact response is worked out every this many pixels - finer
// than a line can show, and its narrowest peaks still come out round.
const PROFILE_STEP_PX = 2
// How much of the previous frame each bar keeps - the same calm the Now
// Playing bars settle at, without their peaks.
const SPECTRUM_SMOOTHING = 0.75

let instances = 0

/** The equalizer's curve with a draggable point per band, over a faint
 * spectrum of the music when `sample` gives one. With `filters` (an
 * imported profile) it is their exact response instead, with no points,
 * and pointing at it reads the level off. */
export default {
  name: 'EqualizerGraph',
  props: {
    gains: { type: Array as PropType<number[]>, required: true },
    enabled: { type: Boolean, default: true },
    disabled: { type: Boolean, default: false },
    /** Bar heights 0..1, BAR_COUNT of them from MIN_FREQ_HZ up - see
     * services/visualizerBands.ts. Null leaves the backdrop empty. */
    sample: { type: Function as PropType<(() => number[] | null) | null>, default: null },
    filters: { type: Array as PropType<readonly EqualizerBand[] | null>, default: null },
  },
  emits: ['change'],
  data() {
    return {
      width: 400,
      height: 220,
      dragging: null as number | null,
      hovered: null as number | null,
      focused: null as number | null,
      /** Where the pointer is over a profile's curve, in pixels. */
      probeX: null as number | null,
      spectrum: null as number[] | null,
      frame: 0,
      observer: null as ResizeObserver | null,
      fillId: `eq-fill-${++instances}`,
    }
  },
  computed: {
    frequencies(): readonly number[] {
      return EQ_FREQUENCIES
    },
    maxGain(): number {
      return EQ_MAX_GAIN_DB
    },
    profile(): boolean {
      return this.filters !== null
    },
    activeIndex(): number | null {
      return this.profile ? null : (this.dragging ?? this.focused ?? this.hovered)
    },
    probe(): { x: number; y: number; label: string } | null {
      if (!this.filters || this.probeX === null) return null
      const frequency = this.frequencyAt(this.probeX)
      const db = responseDb(this.filters, frequency)
      const rounded = Math.round(db * 10) / 10
      const hz = frequency >= 1000 ? `${(frequency / 1000).toFixed(1)}k` : Math.round(frequency)
      return {
        x: this.probeX,
        y: this.gainY(db),
        label: `${hz} Hz · ${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`,
      }
    },
    /** Which bands get their frequency written under the graph. */
    labelled(): boolean[] {
      const every = this.bandX(1) - this.bandX(0) < LABEL_SPACING_PX ? 2 : 1
      return EQ_FREQUENCIES.map((_, i) => i % every === 0)
    },
    /** Drawn through the points themselves rather than as the filters'
     * exact response: octave-wide bands overlap, and the exact curve bulged
     * and dipped between them, which read as the line not following the
     * points. What is heard has this shape, slightly rounder. */
    curvePath(): string {
      if (this.filters) return this.responsePath(this.filters)
      const points = EQ_FREQUENCIES.map(
        (_, i) => [this.bandX(i), this.gainY(this.gains[i] ?? 0)] as [number, number],
      )
      return smoothPath(points, this.width)
    },
    areaPath(): string {
      const zero = this.gainY(0)
      return `${this.curvePath}L${this.width},${zero}L0,${zero}Z`
    },
    dbLines(): { db: number; y: number; label: string }[] {
      return GRID_DB.map((db) => ({
        db,
        y: this.gainY(db),
        label: `${db > 0 ? '+' : ''}${db} dB`,
      }))
    },
    decadeLines(): number[] {
      return DECADES_HZ.map((f) => this.xOf(f))
    },
    spectrumPath(): string | null {
      const bars = this.spectrum
      if (!bars) return null
      const ratio = MAX_FREQ_HZ / MIN_FREQ_HZ
      let d = ''
      for (let i = 0; i < bars.length; i++) {
        const left = this.xOf(MIN_FREQ_HZ * ratio ** (i / BAR_COUNT))
        const right = this.xOf(MIN_FREQ_HZ * ratio ** ((i + 1) / BAR_COUNT))
        if (left >= this.width) break
        const top = this.height * (1 - SPECTRUM_HEIGHT * Math.min(1, bars[i] ?? 0))
        const w = Math.max(1, right - left - 2)
        d += `M${(left + 1).toFixed(1)},${this.height}V${top.toFixed(1)}h${w.toFixed(1)}V${this.height}Z`
      }
      return d
    },
  },
  watch: {
    sample() {
      this.startSpectrum()
    },
  },
  mounted() {
    this.measure()
    this.observer = new ResizeObserver(() => this.measure())
    this.observer.observe(this.$refs.graph as HTMLElement)
    this.startSpectrum()
  },
  beforeUnmount() {
    this.observer?.disconnect()
    cancelAnimationFrame(this.frame)
  },
  methods: {
    measure(): void {
      const el = this.$refs.graph as HTMLElement | undefined
      if (!el || !el.clientWidth) return
      this.width = el.clientWidth
      this.height = el.clientHeight
    },
    /** A moving backdrop is a loop, and a loop stays off for whoever asked
     * for less motion. */
    startSpectrum(): void {
      cancelAnimationFrame(this.frame)
      this.spectrum = null
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      if (this.sample && !still) this.frame = requestAnimationFrame(this.tick)
    },
    tick(): void {
      const next = this.sample?.() ?? null
      const prev = this.spectrum
      this.spectrum =
        next && prev && prev.length === next.length
          ? next.map((v, i) => prev[i]! * SPECTRUM_SMOOTHING + v * (1 - SPECTRUM_SMOOTHING))
          : next
      this.frame = requestAnimationFrame(this.tick)
    },
    xOf(frequency: number): number {
      return (Math.log(frequency / LOW_HZ) / Math.log(HIGH_HZ / LOW_HZ)) * this.width
    },
    frequencyAt(x: number): number {
      return LOW_HZ * (HIGH_HZ / LOW_HZ) ** (x / this.width)
    },
    responsePath(filters: readonly EqualizerBand[]): string {
      let d = ''
      for (let x = 0; x <= this.width; x += PROFILE_STEP_PX) {
        const y = this.gainY(responseDb(filters, this.frequencyAt(x)))
        d += `${d ? 'L' : 'M'}${x},${y.toFixed(1)}`
      }
      return d
    },
    bandX(index: number): number {
      return this.xOf(EQ_FREQUENCIES[index]!)
    },
    gainY(db: number): number {
      const clamped = Math.max(-RANGE_DB, Math.min(RANGE_DB, db))
      return this.height / 2 - (clamped / RANGE_DB) * (this.height / 2 - EDGE_PX)
    },
    gainAt(clientY: number): number {
      const rect = (this.$refs.graph as HTMLElement).getBoundingClientRect()
      const db = (-(clientY - rect.top - rect.height / 2) / (rect.height / 2 - EDGE_PX)) * RANGE_DB
      const stepped = Math.round(db / EQ_STEP_DB) * EQ_STEP_DB
      return Math.max(-EQ_MAX_GAIN_DB, Math.min(EQ_MAX_GAIN_DB, stepped))
    },
    /** The band whose point is nearest left to right - a drag starts
     * anywhere in its column, not only on the small point. */
    bandAt(clientX: number): number {
      const rect = (this.$refs.graph as HTMLElement).getBoundingClientRect()
      const x = clientX - rect.left
      let best = 0
      EQ_FREQUENCIES.forEach((_, i) => {
        if (Math.abs(this.bandX(i) - x) < Math.abs(this.bandX(best) - x)) best = i
      })
      return best
    },
    set(index: number, gain: number): void {
      if (gain !== this.gains[index]) this.$emit('change', index, gain)
    },
    onPointerDown(event: PointerEvent): void {
      if (this.disabled || this.profile || event.button !== 0) return
      this.dragging = this.bandAt(event.clientX)
      ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
      this.set(this.dragging, this.gainAt(event.clientY))
    },
    onPointerMove(event: PointerEvent): void {
      if (this.profile) {
        const rect = (this.$refs.graph as HTMLElement).getBoundingClientRect()
        this.probeX = Math.max(0, Math.min(this.width, event.clientX - rect.left))
        return
      }
      if (this.disabled) return
      if (this.dragging === null) {
        if (event.pointerType === 'mouse') this.hovered = this.bandAt(event.clientX)
        return
      }
      this.set(this.dragging, this.gainAt(event.clientY))
    },
    onPointerUp(): void {
      this.dragging = null
    },
    onDoubleClick(event: MouseEvent): void {
      if (!this.disabled && !this.profile) this.set(this.bandAt(event.clientX), 0)
    },
    onKeydown(index: number, event: KeyboardEvent): void {
      if (this.disabled) return
      const gain = this.gains[index] ?? 0
      const next = (
        {
          ArrowUp: gain + EQ_STEP_DB,
          ArrowRight: gain + EQ_STEP_DB,
          ArrowDown: gain - EQ_STEP_DB,
          ArrowLeft: gain - EQ_STEP_DB,
          PageUp: gain + 3 * EQ_STEP_DB,
          PageDown: gain - 3 * EQ_STEP_DB,
          Home: EQ_MAX_GAIN_DB,
          End: -EQ_MAX_GAIN_DB,
          Delete: 0,
          Backspace: 0,
        } as Record<string, number>
      )[event.key]
      if (next === undefined) return
      event.preventDefault()
      this.set(index, Math.max(-EQ_MAX_GAIN_DB, Math.min(EQ_MAX_GAIN_DB, next)))
    },
    gainLabel(gain: number | undefined): string {
      return gain && gain > 0 ? `+${gain}` : String(gain ?? 0)
    },
    frequencyLabel(frequency: number): string {
      return frequency >= 1000 ? `${frequency / 1000}k` : String(frequency)
    },
    bandLabel(frequency: number): string {
      return this.$t('equalizer.band', { frequency: this.frequencyLabel(frequency) })
    },
  },
}
</script>

<style scoped>
.eq-graph {
  position: relative;
  height: 220px;
  border-radius: 12px;
  border: 1px solid var(--beacon-hairline);
  background: rgba(var(--v-theme-on-surface), 0.025);
  overflow: hidden;
  touch-action: none;
  user-select: none;
  cursor: ns-resize;
}

.eq-graph--disabled {
  cursor: default;
}

.eq-graph--profile {
  cursor: crosshair;
}

.eq-graph__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.eq-graph__spectrum {
  fill: rgba(var(--v-theme-on-surface), 0.05);
}

.eq-graph__grid line {
  stroke: rgba(var(--v-theme-on-surface), 0.06);
}

.eq-graph__grid .eq-graph__zero {
  stroke: rgba(var(--v-theme-on-surface), 0.18);
}

.eq-graph__grid text {
  fill: rgba(var(--v-theme-on-surface), 0.35);
  font-size: 10px;
}

.eq-graph__stop--edge {
  stop-color: rgb(var(--v-theme-primary));
  stop-opacity: 0.26;
}

.eq-graph__stop--zero {
  stop-color: rgb(var(--v-theme-primary));
  stop-opacity: 0.03;
}

.eq-graph__curve {
  fill: none;
  stroke: rgb(var(--v-theme-primary));
  stroke-width: 2.5;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 6px rgba(var(--v-theme-primary), 0.5));
}

.eq-graph__handle {
  position: absolute;
  width: 28px;
  height: 28px;
  margin: -14px 0 0 -14px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  outline: none;
}

.eq-graph__handle::before {
  content: '';
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: rgb(var(--v-theme-surface));
  border: 2px solid rgba(var(--v-theme-primary), 0.6);
  transition:
    transform 0.15s ease,
    background 0.15s ease,
    box-shadow 0.15s ease;
}

.eq-graph__handle--set::before {
  background: rgb(var(--v-theme-primary));
  border-color: rgb(var(--v-theme-primary));
  box-shadow: 0 0 10px rgba(var(--v-theme-primary), 0.7);
}

.eq-graph__handle--active::before,
.eq-graph__handle:focus-visible::before {
  transform: scale(1.35);
}

.eq-graph__handle:focus-visible {
  box-shadow: 0 0 0 2px rgba(var(--v-theme-primary), 0.5);
}

.eq-graph__tip {
  position: absolute;
  transform: translate(-50%, calc(-100% - 16px));
  padding: 3px 8px;
  border-radius: 8px;
  background: rgb(var(--v-theme-surface-bright));
  color: rgb(var(--v-theme-on-surface));
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}

/* Switched off: the curve stays to be worked on, dimmed like a setting that
 * does nothing right now. */
.eq-graph--off .eq-graph__curve,
.eq-graph--off .eq-graph__area,
.eq-graph--off .eq-graph__handle {
  opacity: 0.4;
}

.eq-graph__freqs {
  position: relative;
  height: 18px;
  margin-top: 4px;
}

.eq-graph__freqs span {
  position: absolute;
  transform: translateX(-50%);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 599px) {
  .eq-graph {
    height: 180px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .eq-graph__handle::before {
    transition: none;
  }
}
</style>
