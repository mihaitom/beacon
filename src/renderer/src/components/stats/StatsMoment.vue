<template>
  <!-- Over the whole app, player included, which a surface inside the page
     - could not be. Its own theme class, as outside the app root no theme
     - variables would reach it. -->
  <teleport to="body">
    <div
      class="stats-moment"
      :class="[`v-theme--${appearance.nightTheme}`, { 'stats-moment--leaving': leaving }]"
      role="status"
      @click="close"
    >
      <canvas ref="confetti" class="stats-moment__confetti" />
      <div class="stats-moment__inner">
        <div
          ref="disc"
          class="stats-moment__disc"
          :class="`stats-moment__disc--${moment.tier ?? moment.size}`"
        >
          <div class="stats-moment__vinyl">
            <div class="stats-moment__label"><v-icon :icon="icon" /></div>
          </div>
        </div>
        <div class="stats-moment__text" :class="{ 'stats-moment__text--gone': leaving }">
          <p class="stats-moment__kicker">{{ $t('stats.milestoneKicker') }}</p>
          <p class="stats-moment__title">{{ title }}</p>
          <p class="stats-moment__sub">{{ subtitle }}</p>
        </div>
      </div>
    </div>
  </teleport>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useAppearanceStore } from '@/stores/appearance'
import type { Moment } from '@/services/library/statsMilestones'

const SHOWN_MS = 3700
const BURST_DELAY_MS = 620
const BURST_MS = 1900
const FLIGHT_MS = 620
const PARTICLES = 170
// Foil colours: what the record is made of, the same on every theme.
const CONFETTI = ['#9fe3ff', '#e2c2ff', '#ffc9e5', '#fff0b8', '#b8ffdf', '#f5a94e', '#ffffff']

const ICONS: Record<Moment['kind'], string> = {
  plays: 'mdi-play',
  hours: 'mdi-timer-sand',
  streak: 'mdi-fire',
  pressing: 'mdi-album',
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export default {
  name: 'StatsMoment',
  props: {
    moment: { type: Object as PropType<Moment>, required: true },
    subtitle: { type: String, required: true },
    /** Where the record lands, read when it sets off. */
    target: {
      type: Function as PropType<() => { x: number; y: number; size: number } | null>,
      required: true,
    },
  },
  emits: ['closed'],
  data() {
    return { leaving: false, timers: [] as number[], frame: 0 }
  },
  computed: {
    appearance() {
      return useAppearanceStore()
    },
    icon(): string {
      return ICONS[this.moment.kind]
    },
    title(): string {
      const n = this.moment.value.toLocaleString(this.$i18n.locale)
      const keys = {
        plays: 'stats.milestonePlays',
        hours: 'stats.milestoneHours',
        streak: 'stats.milestoneStreak',
        pressing: 'stats.milestonePressing',
      }
      return this.$t(keys[this.moment.kind], { n })
    },
  },
  mounted() {
    if (!reducedMotion()) this.timers.push(window.setTimeout(this.burst, BURST_DELAY_MS))
    this.timers.push(window.setTimeout(this.close, SHOWN_MS))
    window.addEventListener('keydown', this.onKey)
  },
  beforeUnmount() {
    this.timers.forEach((timer) => clearTimeout(timer))
    cancelAnimationFrame(this.frame)
    window.removeEventListener('keydown', this.onKey)
  },
  methods: {
    onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') this.close()
    },
    close(): void {
      if (this.leaving) return
      this.leaving = true
      this.timers.forEach((timer) => clearTimeout(timer))
      const disc = this.$refs.disc as HTMLElement
      const target = this.target()
      if (reducedMotion() || !target) {
        this.$emit('closed')
        return
      }
      // Into the record in the hero, so the eye knows where it went.
      const from = disc.getBoundingClientRect()
      const dx = target.x - from.left - from.width / 2
      const dy = target.y - from.top - from.height / 2
      disc.style.animation = 'none'
      disc.style.transform = `translate(${dx}px, ${dy}px) scale(${target.size / from.width})`
      this.timers.push(window.setTimeout(() => this.$emit('closed'), FLIGHT_MS))
    },
    burst(): void {
      const canvas = this.$refs.confetti as HTMLCanvasElement
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const ratio = window.devicePixelRatio || 1
      canvas.width = window.innerWidth * ratio
      canvas.height = window.innerHeight * ratio
      ctx.scale(ratio, ratio)
      const originX = window.innerWidth / 2
      const originY = window.innerHeight * 0.42
      const bits = Array.from({ length: PARTICLES }, () => {
        const angle = Math.random() * Math.PI * 2
        const speed = 5 + Math.random() * 15
        return {
          x: originX,
          y: originY,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 3,
          size: 4 + Math.random() * 7,
          spin: Math.random() * 6,
          spinSpeed: (Math.random() - 0.5) * 0.5,
          colour: CONFETTI[Math.floor(Math.random() * CONFETTI.length)] ?? '#ffffff',
        }
      })
      const start = performance.now()
      const draw = (now: number): void => {
        const elapsed = now - start
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
        if (elapsed >= BURST_MS) return
        ctx.globalAlpha = 1 - elapsed / BURST_MS
        for (const bit of bits) {
          bit.vy += 0.24
          bit.vx *= 0.985
          bit.vy *= 0.985
          bit.x += bit.vx
          bit.y += bit.vy
          bit.spin += bit.spinSpeed
          ctx.save()
          ctx.translate(bit.x, bit.y)
          ctx.rotate(bit.spin)
          ctx.fillStyle = bit.colour
          ctx.fillRect(-bit.size / 2, -bit.size / 4, bit.size, bit.size / 2)
          ctx.restore()
        }
        this.frame = requestAnimationFrame(draw)
      }
      this.frame = requestAnimationFrame(draw)
    },
  },
}
</script>

<style scoped>
@property --stats-foil {
  syntax: '<angle>';
  inherits: true;
  initial-value: 80deg;
}

.stats-moment {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: grid;
  place-items: center;
  cursor: pointer;
  background: rgba(6, 7, 11, 0.8);
  backdrop-filter: blur(6px);
  animation: stats-moment-in 0.3s ease-out;
  transition: background 0.4s;
}

.stats-moment--leaving {
  background: transparent;
  backdrop-filter: none;
}

@keyframes stats-moment-in {
  from {
    opacity: 0;
  }
}

.stats-moment__confetti {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.stats-moment__inner {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px;
  text-align: center;
}

.stats-moment__disc {
  width: min(280px, 58vw);
  aspect-ratio: 1;
  animation: stats-moment-press 1s cubic-bezier(0.15, 1.15, 0.3, 1) both;
  transition: transform 0.6s cubic-bezier(0.5, 0, 0.3, 1);
}

@keyframes stats-moment-press {
  from {
    transform: scale(0.25) rotate(-220deg);
    opacity: 0;
  }
}

.stats-moment__vinyl {
  position: relative;
  height: 100%;
  overflow: hidden;
  border-radius: 50%;
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.55);
  animation: stats-moment-foil 2.6s ease-out both;
}

@keyframes stats-moment-foil {
  from {
    --stats-foil: -300deg;
  }
}

/* The grooves. */
.stats-moment__vinyl::before {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-radial-gradient(
    circle,
    rgba(0, 0, 0, 0.2) 0 1px,
    rgba(255, 255, 255, 0.05) 1px 2px,
    transparent 2px 3.5px
  );
}

/* The light moving across them. */
.stats-moment__vinyl::after {
  content: '';
  position: absolute;
  inset: 0;
  mix-blend-mode: screen;
  background: conic-gradient(
    from var(--stats-foil),
    transparent 0 18deg,
    rgba(255, 255, 255, 0.85) 30deg,
    transparent 44deg 196deg,
    rgba(255, 255, 255, 0.6) 210deg,
    transparent 224deg
  );
}

/* Metal, not interface: these stay what they are on every theme. The size
 * of the milestone is in the material, silver to iridescent. */
.stats-moment__disc--bronze {
  --stats-metal: #d99a63;
}

.stats-moment__disc--bronze .stats-moment__vinyl {
  background: conic-gradient(
    from var(--stats-foil),
    #6e4322,
    #b67a45,
    #e6b288,
    #b67a45,
    #6e4322,
    #b67a45,
    #e6b288,
    #b67a45,
    #6e4322
  );
}

.stats-moment__disc--platinum {
  --stats-metal: #e8eef6;
}

.stats-moment__disc--platinum .stats-moment__vinyl {
  background: conic-gradient(
    from var(--stats-foil),
    #9fb2c9,
    #e8eef6,
    #ffffff,
    #e8eef6,
    #9fb2c9,
    #e8eef6,
    #ffffff,
    #e8eef6,
    #9fb2c9
  );
}

.stats-moment__disc--s,
.stats-moment__disc--silver {
  --stats-metal: #d9dee6;
}

.stats-moment__disc--s .stats-moment__vinyl,
.stats-moment__disc--silver .stats-moment__vinyl {
  background: conic-gradient(
    from var(--stats-foil),
    #5f6673,
    #a4acb9,
    #d9dee6,
    #a4acb9,
    #5f6673,
    #a4acb9,
    #d9dee6,
    #a4acb9,
    #5f6673
  );
}

.stats-moment__disc--m,
.stats-moment__disc--gold {
  --stats-metal: #f0c75e;
}

.stats-moment__disc--m .stats-moment__vinyl,
.stats-moment__disc--gold .stats-moment__vinyl {
  background: conic-gradient(
    from var(--stats-foil),
    #a0741b,
    #f0c75e,
    #fff0b8,
    #f0c75e,
    #a0741b,
    #f0c75e,
    #ffefb0,
    #f0c75e,
    #a0741b
  );
}

.stats-moment__disc--l,
.stats-moment__disc--diamond {
  --stats-metal: #bfe7ff;
}

.stats-moment__disc--l .stats-moment__vinyl,
.stats-moment__disc--diamond .stats-moment__vinyl {
  background: conic-gradient(
    from var(--stats-foil),
    #9fe3ff,
    #e2c2ff,
    #ffc9e5,
    #fff0b8,
    #b8ffdf,
    #9fe3ff,
    #e2c2ff,
    #ffc9e5,
    #fff0b8,
    #b8ffdf,
    #9fe3ff
  );
  box-shadow:
    0 12px 26px rgba(0, 0, 0, 0.55),
    0 0 26px rgba(170, 220, 255, 0.4);
}

.stats-moment__label {
  position: absolute;
  inset: 32%;
  z-index: 1;
  display: grid;
  place-items: center;
  font-size: 44px;
  border-radius: 50%;
  color: var(--stats-metal);
  background: radial-gradient(circle at 35% 30%, #2a2e3b, #12141c);
  box-shadow:
    0 0 0 2px var(--stats-metal),
    inset 0 0 8px rgba(0, 0, 0, 0.6);
}

.stats-moment__text {
  animation: stats-moment-rise 0.5s ease-out 0.55s both;
  transition: opacity 0.2s;
}

.stats-moment__text--gone {
  opacity: 0;
}

@keyframes stats-moment-rise {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
}

.stats-moment__kicker {
  margin-top: 12px;
  font-size: 1.05rem;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
}

.stats-moment__title {
  font-family: Georgia, 'Times New Roman', serif;
  font-weight: 600;
  font-size: clamp(2.5rem, 7vw, 4.6rem);
  line-height: 1.05;
  color: #fff;
}

.stats-moment__sub {
  margin-top: 8px;
  font-size: 1.05rem;
  color: rgba(255, 255, 255, 0.75);
}

@media (prefers-reduced-motion: reduce) {
  .stats-moment,
  .stats-moment__disc,
  .stats-moment__vinyl,
  .stats-moment__text {
    animation: none;
  }
}
</style>
