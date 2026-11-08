<template>
  <svg
    ref="svg"
    class="stats-record"
    :class="{ 'stats-record--lit': lit, 'stats-record--playing': playing }"
    viewBox="0 0 640 560"
    aria-hidden="true"
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
      <filter id="stats-record-soft" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="16" />
      </filter>
    </defs>

    <circle :cx="CX" :cy="CY" r="266" fill="url(#stats-record-vinyl)" class="stats-record__rim" />
    <path :d="sheen(1)" class="stats-record__sheen" filter="url(#stats-record-soft)" />
    <path :d="sheen(-1)" class="stats-record__sheen" filter="url(#stats-record-soft)" />

    <circle
      v-for="groove in grooves"
      :key="groove.n"
      class="stats-record__groove"
      :class="{
        'stats-record__groove--played': groove.played,
        'stats-record__groove--mark': groove.mark,
      }"
      :style="{ '--i': groove.n }"
      :cx="CX"
      :cy="CY"
      :r="groove.r"
    />
    <circle
      class="stats-record__now"
      :cx="CX"
      :cy="CY"
      :r="nowRadius"
      :transform="`rotate(-90 ${CX} ${CY})`"
      :stroke-dasharray="nowLength"
      :style="{ '--len': nowLength, '--to': nowLength * (1 - record.progress) }"
    />

    <g class="stats-record__label">
      <circle :cx="CX" :cy="CY" :r="LABEL_R" class="stats-record__blank" />
      <image
        v-if="coverUrl"
        :href="coverUrl"
        :x="CX - LABEL_R"
        :y="CY - LABEL_R"
        :width="LABEL_R * 2"
        :height="LABEL_R * 2"
        preserveAspectRatio="xMidYMid slice"
        clip-path="url(#stats-record-label)"
      />
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
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { RECORD_GROOVES, type RecordProgress } from '@/services/library/statsMilestones'

const CX = 270
const CY = 280
const OUTER = 250
const INNER = 96
const LABEL_R = 84
const VIEW_WIDTH = 640
const VIEW_HEIGHT = 560
const PIVOT_X = 600
const PIVOT_Y = 70
const ARM = 350
// Where the arm parks, just off the record's edge.
const REST_RADIUS = 292
const PIVOT_TO_CENTRE = Math.hypot(CX - PIVOT_X, CY - PIVOT_Y)
const TOWARDS_CENTRE = (Math.atan2(CY - PIVOT_Y, CX - PIVOT_X) * 180) / Math.PI

function grooveRadius(n: number): number {
  return OUTER - ((n - 1) * (OUTER - INNER)) / (RECORD_GROOVES - 1)
}

/** The arm's angle that puts the stylus on a circle of radius `r` around the
 * spindle, by the cosine rule on pivot, spindle and stylus. */
function armAngle(r: number): number {
  const cosine =
    (ARM * ARM + PIVOT_TO_CENTRE * PIVOT_TO_CENTRE - r * r) / (2 * ARM * PIVOT_TO_CENTRE)
  return TOWARDS_CENTRE - (Math.acos(cosine) * 180) / Math.PI
}

export default {
  name: 'StatsRecord',
  props: {
    record: { type: Object as PropType<RecordProgress>, required: true },
    coverUrl: { type: String as PropType<string | null>, default: null },
    playing: { type: Boolean, default: false },
    lit: { type: Boolean, default: false },
  },
  data() {
    return { CX, CY, ARM, LABEL_R }
  },
  computed: {
    grooves(): { n: number; r: number; played: boolean; mark: boolean }[] {
      const current = this.record.done + 1
      return Array.from({ length: RECORD_GROOVES }, (_, index) => index + 1)
        .filter((n) => n !== current)
        .map((n) => ({
          n,
          r: grooveRadius(n),
          played: n < current,
          mark: n < current && n % 10 === 0,
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
        '--play': `${armAngle(this.nowRadius)}deg`,
      }
    },
  },
  methods: {
    sheen(side: 1 | -1): string {
      const [a, b, c, d] = [-150 * side, -240 * side, 40 * side, -262 * side]
      return `M${CX} ${CY} L${CX + a} ${CY + b} L${CX + c} ${CY + d} Z`
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
  overflow: visible;
}

/* The record itself is an object in the room, black on every theme; only the
 * grooves speak in the theme's colours. */
.stats-record__rim {
  stroke: rgba(255, 255, 255, 0.07);
}

.stats-record__sheen {
  fill: rgba(255, 255, 255, 0.07);
}

.stats-record__groove {
  fill: none;
  stroke: rgba(255, 255, 255, 0.07);
  stroke-width: 1;
  transition: stroke 0.2s;
}

/* Quiet on purpose: a record of amber lines was a large amber thing, which
 * the accent is not. It marks every tenth groove and the current one. */
.stats-record--lit .stats-record__groove--played {
  stroke: rgba(255, 255, 255, 0.3);
  transition-delay: calc(var(--i) * 16ms + 200ms);
}

.stats-record--lit .stats-record__groove--mark {
  stroke: rgba(var(--v-theme-primary), 0.75);
}

.stats-record__now {
  fill: none;
  stroke: rgb(var(--v-theme-primary));
  stroke-width: 2.4;
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

.stats-record__label {
  transform-box: fill-box;
  transform-origin: center;
  animation: stats-record-spin 6s linear infinite paused;
}

.stats-record--playing .stats-record__label {
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
  transition: transform 1.1s cubic-bezier(0.3, 1.1, 0.4, 1) 0.1s;
}

.stats-record--lit .stats-record__arm {
  transform: translate(600px, 70px) rotate(var(--play));
}

.stats-record__pivot {
  fill: rgb(var(--v-theme-surface-bright));
  stroke: rgba(255, 255, 255, 0.14);
}

.stats-record__stylus {
  fill: rgb(var(--v-theme-primary));
}

@media (prefers-reduced-motion: reduce) {
  .stats-record__label {
    animation: none;
  }

  .stats-record__groove,
  .stats-record__now,
  .stats-record__arm {
    transition: none !important;
  }
}
</style>
