<template>
  <section class="stats-hero" :class="`v-theme--${appearance.nightTheme}`">
    <v-theme-provider :theme="appearance.nightTheme">
      <div class="stats-hero__layout">
        <div
          v-if="coverUrl"
          class="stats-hero__art"
          :style="{ backgroundImage: `url(&quot;${coverUrl}&quot;)` }"
        />
        <div class="stats-hero__scrim" />
        <div class="stats-hero__text">
          <h1 class="stats-hero__title" :class="{ 'is-fresh': fresh === 'hours' }">{{ title }}</h1>
          <p v-if="statement" class="stats-hero__statement">{{ statement }}</p>
          <div v-if="!otherAccount" class="stats-hero__next">
            <div class="stats-hero__track">
              <div
                class="stats-hero__fill"
                :style="{ width: lit ? `${record.progress * 100}%` : '0' }"
              />
            </div>
            <p class="text-body-medium text-medium-emphasis">
              {{
                $t(
                  'stats.heroNext',
                  { remaining: formatNumber(record.remaining), next: formatNumber(record.next) },
                  record.remaining,
                )
              }}
            </p>
          </div>
          <div class="stats-hero__figures">
            <div class="stats-hero__figure" :class="{ 'is-fresh': fresh === 'plays' }">
              <strong>{{ formatNumber(shown(plays)) }}</strong>
              <span class="text-body-small text-medium-emphasis">{{ $t('stats.totalPlays') }}</span>
            </div>
            <div v-if="libraryShare" class="stats-hero__figure">
              <strong>{{ libraryShare }}</strong>
              <span class="text-body-small text-medium-emphasis">{{
                $t('stats.playedShare')
              }}</span>
            </div>
            <div
              v-if="streak > 0"
              class="stats-hero__figure"
              :class="{ 'is-fresh': fresh === 'streak' }"
            >
              <strong>{{ formatNumber(shown(streak)) }}</strong>
              <span class="text-body-small text-medium-emphasis">
                {{ $t('stats.streakFigure', streak) }}
              </span>
            </div>
          </div>
        </div>
        <div class="stats-hero__deck">
          <stats-record
            ref="record"
            class="stats-hero__record"
            :record="record"
            :cover-url="coverUrl"
            :playing="playing"
            :lit="lit"
          />
        </div>
      </div>
    </v-theme-provider>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useAppearanceStore } from '@/stores/appearance'
import { recordProgress, type MilestoneKind } from '@/services/library/statsMilestones'
import StatsRecord from './StatsRecord.vue'

const COUNT_UP_MS = 1300
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600
const SECONDS_PER_DAY = 86400
// Frankfurt to New York, a flight most people have a feeling for.
const FLIGHT_SECONDS = 8.5 * SECONDS_PER_HOUR

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export default {
  name: 'StatsHero',
  components: { StatsRecord },
  props: {
    listeningSeconds: { type: Number, default: 0 },
    plays: { type: Number, required: true },
    libraryShare: { type: String as PropType<string | null>, default: null },
    streak: { type: Number, default: 0 },
    coverUrl: { type: String as PropType<string | null>, default: null },
    playing: { type: Boolean, default: false },
    /** Someone else's page: the name and their log, no total listening time. */
    otherAccount: { type: String as PropType<string | null>, default: null },
    since: { type: String as PropType<string | null>, default: null },
    fresh: { type: String as PropType<MilestoneKind | null>, default: null },
  },
  data() {
    return { lit: false, reveal: 0, frame: 0 }
  },
  computed: {
    appearance() {
      return useAppearanceStore()
    },
    record() {
      return recordProgress(this.plays)
    },
    title(): string {
      if (this.otherAccount) return this.otherAccount
      const seconds = this.listeningSeconds
      if (seconds >= SECONDS_PER_DAY)
        return this.titleOf('stats.heroDays', seconds / SECONDS_PER_DAY)
      if (seconds >= SECONDS_PER_HOUR) {
        return this.titleOf('stats.heroHours', seconds / SECONDS_PER_HOUR)
      }
      return this.titleOf('stats.heroMinutes', seconds / SECONDS_PER_MINUTE)
    },
    statement(): string | null {
      if (this.otherAccount) {
        return this.since
          ? this.$t(
              'stats.otherSince',
              { n: this.formatNumber(this.plays), date: this.since },
              this.plays,
            )
          : null
      }
      const flights = Math.round(this.listeningSeconds / FLIGHT_SECONDS)
      if (flights < 1) return null
      return this.$t('stats.heroFlights', { n: this.formatNumber(this.shown(flights)) }, flights)
    },
  },
  mounted() {
    if (reducedMotion()) {
      this.lit = true
      this.reveal = 1
      return
    }
    // Two frames, so the browser has painted the unlit record to animate from.
    this.frame = requestAnimationFrame(() => {
      this.frame = requestAnimationFrame(() => {
        this.lit = true
        this.countUp()
      })
    })
  },
  beforeUnmount() {
    cancelAnimationFrame(this.frame)
  },
  methods: {
    titleOf(key: string, amount: number): string {
      const whole = Math.floor(amount)
      return this.$t(key, { n: this.formatNumber(this.shown(whole)) }, whole)
    },
    shown(value: number): number {
      return Math.round(value * this.reveal)
    },
    countUp(): void {
      const start = performance.now()
      const tick = (now: number): void => {
        const elapsed = Math.min(1, (now - start) / COUNT_UP_MS)
        this.reveal = 1 - Math.pow(1 - elapsed, 4)
        if (elapsed < 1) this.frame = requestAnimationFrame(tick)
      }
      this.frame = requestAnimationFrame(tick)
    },
    formatNumber(value: number): string {
      return value.toLocaleString(this.$i18n.locale)
    },
    /** For a record flying in from elsewhere on the page. */
    labelRect(): { x: number; y: number; size: number } {
      return (this.$refs.record as InstanceType<typeof StatsRecord>).labelRect()
    },
  },
}
</script>

<style scoped>
.stats-hero {
  container-type: inline-size;
  position: relative;
  overflow: hidden;
  isolation: isolate;
  border-radius: 16px;
  color: rgb(var(--v-theme-on-surface));
  background: rgb(var(--v-theme-background));
}

/* A box of its own inside the section: a container query cannot restyle the
 * container it is measuring. */
.stats-hero__layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
  min-height: clamp(420px, 42cqi, 640px);
}

/* The app's artwork backdrop: docs/styleguide.md. */
.stats-hero__art {
  position: absolute;
  inset: -20px;
  z-index: -2;
  background-size: cover;
  background-position: center;
  filter: blur(38px) saturate(1.4) brightness(0.55);
  transform: scale(1.15);
}

.stats-hero__scrim {
  position: absolute;
  inset: 0;
  z-index: -1;
  background:
    linear-gradient(
      120deg,
      rgba(18, 20, 28, 0.94),
      rgba(18, 20, 28, 0.74) 48%,
      rgba(var(--v-theme-primary), 0.18)
    ),
    linear-gradient(to bottom, transparent 55%, rgba(18, 20, 28, 0.55));
}

.stats-hero__text {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 22px;
  min-width: 0;
  padding: clamp(24px, 4cqi, 56px);
}

.stats-hero__title {
  font-family: Georgia, 'Times New Roman', serif;
  font-weight: 600;
  font-size: clamp(2.75rem, 5.8cqi, 6.2rem);
  line-height: 1.02;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
}

.stats-hero__statement {
  max-width: 30ch;
  font-size: clamp(1.15rem, 1.7cqi, 1.5rem);
  font-weight: 500;
  line-height: 1.35;
}

.stats-hero__next {
  max-width: 460px;
}

.stats-hero__track {
  height: 8px;
  margin-bottom: 8px;
  overflow: hidden;
  border-radius: 4px;
  background: rgba(var(--v-theme-on-surface), 0.12);
}

.stats-hero__fill {
  height: 100%;
  border-radius: 4px;
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 0 14px rgba(var(--v-theme-primary), 0.7);
  transition: width 1.3s cubic-bezier(0.2, 0.8, 0.2, 1) 0.25s;
}

.stats-hero__figures {
  display: flex;
  flex-wrap: wrap;
  gap: 14px 40px;
}

.stats-hero__figure strong {
  display: block;
  font-size: 1.7rem;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}

.stats-hero__deck {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
}

.stats-hero__record {
  width: auto;
  max-width: 104%;
  height: min(106%, 700px);
  margin: -3% 1% -3% 0;
}

.is-fresh {
  transform-origin: left center;
  animation: stats-hero-landed 0.9s ease-out;
}

@keyframes stats-hero-landed {
  from {
    transform: scale(1.14);
    filter: brightness(1.8) drop-shadow(0 0 16px rgba(var(--v-theme-primary), 0.9));
  }
}

@container (max-width: 760px) {
  .stats-hero__layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .stats-hero__deck {
    order: -1;
    justify-content: center;
    padding: 14px 14px 0;
  }

  .stats-hero__record {
    width: 100%;
    max-width: 420px;
    height: auto;
    margin: 0;
  }

  .stats-hero__text {
    padding-top: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .stats-hero__fill {
    transition: none;
  }

  .is-fresh {
    animation: none;
  }
}
</style>
