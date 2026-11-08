<template>
  <!-- One root: a parent's scoped class only reaches a single-root child. -->
  <div>
    <svg
      ref="svg"
      class="stats-record"
      :class="{ 'stats-record--lit': lit, 'stats-record--playing': playing }"
      viewBox="0 0 640 560"
      aria-hidden="true"
      @pointermove="onPointer"
      @pointerdown="onPointer"
      @pointerleave="onLeave"
    >
      <defs>
        <clipPath id="stats-record-label"><circle :cx="CX" :cy="CY" :r="LABEL_R" /></clipPath>
        <radialGradient id="stats-record-vinyl">
          <stop offset="0.3" stop-color="#16181f" />
          <stop offset="1" stop-color="#090a0f" />
        </radialGradient>
        <linearGradient id="stats-record-arm" x2="1">
          <stop stop-color="#8d93a3" />
          <stop offset="1" stop-color="#e6e9f0" />
        </linearGradient>
        <linearGradient id="stats-record-foil" x2="1" y2="1">
          <stop stop-color="#9fe3ff" />
          <stop offset="0.3" stop-color="#e2c2ff" />
          <stop offset="0.55" stop-color="#ffc9e5" />
          <stop offset="0.8" stop-color="#fff0b8" />
          <stop offset="1" stop-color="#b8ffdf" />
        </linearGradient>
        <filter id="stats-record-soft" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
        <!-- The light lies on the grooves, not on the paper label. -->
        <mask id="stats-record-grooves">
          <circle :cx="CX" :cy="CY" r="266" fill="#fff" />
          <circle :cx="CX" :cy="CY" :r="INNER - 8" fill="#000" />
        </mask>
      </defs>

      <circle :cx="CX" :cy="CY" r="266" fill="url(#stats-record-vinyl)" class="stats-record__rim" />

      <circle v-for="r in fineLines" :key="r" class="stats-record__fine" :cx="CX" :cy="CY" :r="r" />
      <circle
        v-for="groove in grooves"
        :key="groove.n"
        class="stats-record__groove"
        :class="{ 'stats-record__groove--played': groove.played }"
        :style="{ '--i': groove.n }"
        :cx="CX"
        :cy="CY"
        :r="groove.r"
      />
      <circle
        v-for="ring in rings"
        :key="ring.groove"
        class="stats-record__ring"
        :cx="CX"
        :cy="CY"
        :r="ring.r"
        :stroke="ring.stroke"
      />

      <!-- A fixed light: the record turns underneath it, only the pointer moves it. -->
      <g mask="url(#stats-record-grooves)">
        <g ref="light" class="stats-record__light">
          <path :d="sheen(1, 34)" class="stats-record__sheen" filter="url(#stats-record-soft)" />
          <path :d="sheen(-1, 34)" class="stats-record__sheen" filter="url(#stats-record-soft)" />
          <path :d="sheen(1, 8)" class="stats-record__glint" filter="url(#stats-record-soft)" />
          <path :d="sheen(-1, 8)" class="stats-record__glint" filter="url(#stats-record-soft)" />
        </g>
      </g>

      <circle v-if="hovered" class="stats-record__hovered" :cx="CX" :cy="CY" :r="hoveredRadius" />

      <!-- Grooves are the same all the way round, so the turning shows on what
         - is not: the arc of plays and the label. -->
      <g class="stats-record__platter">
        <circle
          class="stats-record__now"
          :cx="CX"
          :cy="CY"
          :r="nowRadius"
          :transform="`rotate(-90 ${CX} ${CY})`"
          :stroke-dasharray="nowLength"
          :style="{ '--len': nowLength, '--to': nowLength * (1 - record.progress) }"
        />
        <circle :cx="CX" :cy="CY" :r="LABEL_R" class="stats-record__blank" />
        <transition name="stats-record-swap">
          <image
            v-if="coverUrl"
            :key="coverUrl"
            :href="coverUrl"
            :x="CX - LABEL_R"
            :y="CY - LABEL_R"
            :width="LABEL_R * 2"
            :height="LABEL_R * 2"
            preserveAspectRatio="xMidYMid slice"
            clip-path="url(#stats-record-label)"
          />
        </transition>
      </g>
      <circle :cx="CX" :cy="CY" r="7" class="stats-record__spindle" />

      <g class="stats-record__arm" :style="armAngles">
        <circle r="30" class="stats-record__pivot" />
        <circle r="11" fill="#8d93a3" />
        <rect x="-54" y="-9" width="34" height="18" rx="4" fill="#3a3f4e" />
        <rect y="-3" :width="ARM - 28" height="6" rx="3" fill="url(#stats-record-arm)" />
        <rect :x="ARM - 34" y="-9" width="42" height="18" rx="3" fill="#e6e9f0" />
        <circle :cx="ARM" r="3" class="stats-record__stylus" />
      </g>
    </svg>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import {
  grooveAtRadius,
  grooveInfo,
  grooveRadius,
  milestoneRings,
  RECORD_GROOVES,
  RECORD_INNER,
  type MilestoneRing,
  type RecordProgress,
} from '@/services/library/statsMilestones'

const CX = 270
const CY = 280
const LABEL_R = 84
const VIEW_WIDTH = 640
const VIEW_HEIGHT = 560
const PIVOT_X = 600
const PIVOT_Y = 70
const ARM = 350
// Where the arm parks, just off the record's edge.
const REST_RADIUS = 292
// How far outward a paused arm hangs over the groove it left.
const LIFT = 16
// A finger has no hover: a tap shows the groove for this long.
const TOUCH_TIP_MS = 2500
const PIVOT_TO_CENTRE = Math.hypot(CX - PIVOT_X, CY - PIVOT_Y)
const TOWARDS_CENTRE = (Math.atan2(CY - PIVOT_Y, CX - PIVOT_X) * 180) / Math.PI
// Foil is a gradient; metal is what the milestone discs are made of.
const RING_STROKES: Record<MilestoneRing['size'], string> = {
  s: '#8b93a1',
  m: '#f0c75e',
  l: 'url(#stats-record-foil)',
}

/** The arm's angle that puts the stylus on a circle of radius `r` around the
 * spindle, by the cosine rule on pivot, spindle and stylus. */
function armAngle(r: number): number {
  const cosine =
    (ARM * ARM + PIVOT_TO_CENTRE * PIVOT_TO_CENTRE - r * r) / (2 * ARM * PIVOT_TO_CENTRE)
  return TOWARDS_CENTRE - (Math.acos(cosine) * 180) / Math.PI
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export default {
  name: 'StatsRecord',
  props: {
    record: { type: Object as PropType<RecordProgress>, required: true },
    coverUrl: { type: String as PropType<string | null>, default: null },
    playing: { type: Boolean, default: false },
    lit: { type: Boolean, default: false },
    /** The plays milestone celebrated so far. */
    seenPlays: { type: Number, default: 0 },
  },
  emits: ['hover-line'],
  data() {
    return {
      CX,
      CY,
      ARM,
      LABEL_R,
      INNER: RECORD_INNER,
      hovered: null as number | null,
      touchTimer: 0,
      lightFrame: 0,
    }
  },
  computed: {
    grooves(): { n: number; r: number; played: boolean }[] {
      const current = this.record.done + 1
      return Array.from({ length: RECORD_GROOVES }, (_, index) => index + 1)
        .filter((n) => n !== current)
        .map((n) => ({ n, r: grooveRadius(n), played: n < current }))
    },
    /** Between the grooves that mean something: what makes it look like vinyl. */
    fineLines(): number[] {
      return Array.from({ length: RECORD_GROOVES - 1 }, (_, index) => grooveRadius(index + 1.5))
    },
    rings(): (MilestoneRing & { r: number; stroke: string })[] {
      return milestoneRings(this.seenPlays, this.record).map((ring) => ({
        ...ring,
        r: grooveRadius(ring.groove),
        stroke: RING_STROKES[ring.size],
      }))
    },
    nowRadius(): number {
      return grooveRadius(this.record.done + 1)
    },
    nowLength(): number {
      return 2 * Math.PI * this.nowRadius
    },
    armAngles(): Record<string, string> {
      return {
        '--rest': `${armAngle(REST_RADIUS)}deg`,
        '--lift': `${armAngle(this.nowRadius + LIFT)}deg`,
        '--play': `${armAngle(this.nowRadius)}deg`,
      }
    },
    hoveredRadius(): number {
      return this.hovered === null ? 0 : grooveRadius(this.hovered)
    },
    hoveredRing(): MilestoneRing | undefined {
      return this.rings.find((ring) => ring.groove === this.hovered)
    },
    /** What the pointed-at groove stands for, said elsewhere on the page: a
     * tooltip riding on the pointer covered the record being pointed at. */
    hoverLine(): string {
      if (this.hovered === null) return ''
      const info = grooveInfo(this.record, this.hovered)
      const format = (value: number): string => value.toLocaleString(this.$i18n.locale)
      const n = format(info.n)
      const ring = this.hoveredRing
      const groove =
        info.state === 'ahead'
          ? this.$t('stats.recordGrooveAhead', { n, left: format(info.left) }, info.left)
          : info.state === 'current'
            ? this.$t('stats.recordGrooveNow', {
                n,
                at: format(this.record.next - this.record.remaining),
                to: format(info.to),
              })
            : this.$t('stats.recordGroove', { n, from: format(info.from), to: format(info.to) })
      return ring ? `${groove}. ${this.$t('stats.recordRing', { n: format(ring.value) })}` : groove
    },
  },
  watch: {
    hoverLine(line: string): void {
      this.$emit('hover-line', line)
    },
  },
  beforeUnmount() {
    clearTimeout(this.touchTimer)
    cancelAnimationFrame(this.lightFrame)
  },
  methods: {
    sheen(side: 1 | -1, spread: number): string {
      const reach = 290
      const point = (degrees: number): string => {
        const radians = ((degrees - 90) * Math.PI) / 180
        return `${CX + Math.cos(radians) * reach} ${CY + Math.sin(radians) * reach}`
      }
      const centre = side === 1 ? 0 : 180
      return `M${CX} ${CY} L${point(centre - spread / 2)} L${point(centre + spread / 2)} Z`
    },
    onPointer(event: PointerEvent): void {
      const box = (this.$refs.svg as SVGSVGElement).getBoundingClientRect()
      if (!box.width) return
      const scale = VIEW_WIDTH / box.width
      const x = (event.clientX - box.left) * scale - CX
      const y = (event.clientY - box.top) * scale - CY
      this.hovered = grooveAtRadius(Math.hypot(x, y))
      if (event.pointerType === 'touch') {
        clearTimeout(this.touchTimer)
        this.touchTimer = window.setTimeout(this.clearHover, TOUCH_TIP_MS)
      } else {
        this.moveLight((Math.atan2(y, x) * 180) / Math.PI + 90)
      }
    },
    onLeave(event: PointerEvent): void {
      if (event.pointerType === 'touch') return
      this.clearHover()
      this.moveLight(0)
    },
    clearHover(): void {
      this.hovered = null
    },
    /** Straight onto the element: re-rendering the grooves for every mouse
     * move would be eighty circles for one angle. */
    moveLight(degrees: number): void {
      if (reducedMotion()) return
      cancelAnimationFrame(this.lightFrame)
      this.lightFrame = requestAnimationFrame(() => {
        const light = this.$refs.light as SVGGElement | undefined
        light?.style.setProperty('--light', `${degrees}deg`)
      })
    },
    /** Where the cover sits on screen, for a record flying into it. */
    labelRect(): { x: number; y: number; size: number } {
      const box = (this.$refs.svg as SVGSVGElement).getBoundingClientRect()
      return {
        x: box.left + (box.width * CX) / VIEW_WIDTH,
        y: box.top + (box.height * CY) / VIEW_HEIGHT,
        size: (box.width * LABEL_R * 2) / VIEW_WIDTH,
      }
    },
  },
}
</script>

<style scoped>
.stats-record {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

/* The record itself is an object in the room, black on every theme; only the
 * grooves speak in the theme's colours. */
.stats-record__rim {
  stroke: rgba(255, 255, 255, 0.07);
}

.stats-record__fine {
  fill: none;
  stroke: rgba(255, 255, 255, 0.05);
  stroke-width: 0.6;
}

.stats-record__groove {
  fill: none;
  stroke: rgba(255, 255, 255, 0.08);
  stroke-width: 1.5;
  transition: stroke 0.2s;
}

/* Quiet on purpose: amber is for the groove being played, nothing else. */
.stats-record--lit .stats-record__groove--played {
  stroke: rgba(255, 255, 255, 0.24);
  transition-delay: calc(var(--i) * 24ms + 200ms);
}

.stats-record__ring {
  fill: none;
  stroke-width: 2.2;
  opacity: 0;
  animation: stats-record-engrave 0.6s ease-out 1.1s forwards;
}

@keyframes stats-record-engrave {
  to {
    opacity: 0.9;
  }
}

.stats-record__hovered {
  fill: none;
  stroke: rgba(255, 255, 255, 0.9);
  stroke-width: 3;
  pointer-events: none;
}

.stats-record__light {
  transform-box: view-box;
  transform-origin: 270px 280px;
  transform: rotate(var(--light, 0deg));
  transition: transform 0.25s ease-out;
  pointer-events: none;
}

.stats-record__sheen {
  fill: rgba(255, 255, 255, 0.09);
}

.stats-record__glint {
  fill: rgba(255, 255, 255, 0.2);
}

.stats-record__now {
  fill: none;
  stroke: rgb(var(--v-theme-primary));
  stroke-width: 2.8;
  stroke-linecap: round;
  filter: drop-shadow(0 0 5px rgba(var(--v-theme-primary), 0.95));
  stroke-dashoffset: var(--len);
  transition: stroke-dashoffset 0.8s ease-out 1s;
}

.stats-record--lit .stats-record__now {
  stroke-dashoffset: var(--to);
}

.stats-record__blank {
  fill: rgb(var(--v-theme-surface-bright));
}

.stats-record-swap-enter-active,
.stats-record-swap-leave-active {
  transition: opacity 0.5s;
}

.stats-record-swap-enter-from,
.stats-record-swap-leave-to {
  opacity: 0;
}

.stats-record__platter {
  transform-box: view-box;
  transform-origin: 270px 280px;
  animation: stats-record-spin 6s linear infinite paused;
}

.stats-record--playing .stats-record__platter {
  animation-play-state: running;
}

@keyframes stats-record-spin {
  to {
    transform: rotate(360deg);
  }
}

.stats-record__spindle {
  fill: rgb(var(--v-theme-background));
  stroke: #8d93a3;
}

.stats-record__arm {
  transform: translate(600px, 70px) rotate(var(--rest));
  filter: drop-shadow(10px 16px 8px rgba(0, 0, 0, 0.5));
  transition:
    transform 1.1s cubic-bezier(0.3, 1.1, 0.4, 1) 0.1s,
    filter 0.5s;
}

/* Paused: lifted off the groove, so it hangs beside it with a longer shadow. */
.stats-record--lit .stats-record__arm {
  transform: translate(600px, 70px) rotate(var(--lift));
}

.stats-record--lit.stats-record--playing .stats-record__arm {
  transform: translate(600px, 70px) rotate(var(--play));
  filter: drop-shadow(3px 5px 3px rgba(0, 0, 0, 0.55));
}

.stats-record__pivot {
  fill: rgb(var(--v-theme-surface-bright));
  stroke: rgba(255, 255, 255, 0.14);
}

.stats-record__stylus {
  fill: rgb(var(--v-theme-primary));
}

@media (prefers-reduced-motion: reduce) {
  .stats-record__platter,
  .stats-record__ring {
    animation: none;
  }

  .stats-record__ring {
    opacity: 0.9;
  }

  .stats-record__groove,
  .stats-record__now,
  .stats-record__arm,
  .stats-record__light {
    transition: none !important;
  }
}
</style>
