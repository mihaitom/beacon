<template>
  <section class="stats-hero" :class="`v-theme--${appearance.nightTheme}`">
    <v-theme-provider :theme="appearance.nightTheme">
      <div class="stats-hero__layout">
        <transition name="stats-hero-art">
          <div
            v-if="backdropUrl"
            :key="backdropUrl"
            class="stats-hero__art"
            :style="{ backgroundImage: `url(&quot;${backdropUrl}&quot;)` }"
          />
        </transition>
        <div class="stats-hero__scrim" />
        <div class="stats-hero__text">
          <h1
            ref="hoursFigure"
            class="stats-hero__title"
            :class="{ 'is-fresh': fresh === 'hours' }"
          >
            {{ title }}
          </h1>
          <p v-if="statement" class="stats-hero__statement">{{ statement }}</p>
          <div class="stats-hero__next">
            <div v-if="!otherAccount" class="stats-hero__track">
              <div
                class="stats-hero__fill"
                :style="{ width: lit ? `${record.progress * 100}%` : '0' }"
              />
            </div>
            <p class="text-body-medium text-medium-emphasis stats-hero__line">
              {{ grooveLine || nextLine }}
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
              <strong ref="streakFigure">{{ formatNumber(shown(streak)) }}</strong>
              <span class="text-body-small text-medium-emphasis">
                {{ $t('stats.streakFigure', streak) }}
              </span>
            </div>
          </div>
        </div>
        <div class="stats-hero__deck">
          <div class="stats-hero__turntable">
            <stats-record
              ref="record"
              class="stats-hero__record"
              :record="record"
              :cover-url="backdropUrl"
              :seen-plays="seenPlays"
              :playing="playing"
              :lit="lit"
              @hover-line="grooveLine = $event"
            />
            <stats-shelf
              ref="shelf"
              class="stats-hero__shelf"
              :records="pressed"
              :seen="seenRecords"
              :landed="landedRecord"
            />
          </div>
        </div>
      </div>
    </v-theme-provider>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useAppearanceStore } from '@/stores/appearance'
import { pressedRecords, recordProgress, type Moment } from '@/services/library/statsMilestones'
import StatsRecord from './StatsRecord.vue'
import StatsShelf from './StatsShelf.vue'

const COUNT_UP_MS = 1300
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600
const SECONDS_PER_DAY = 86400

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export default {
  name: 'StatsHero',
  components: { StatsRecord, StatsShelf },
  props: {
    listeningSeconds: { type: Number, default: 0 },
    plays: { type: Number, required: true },
    libraryShare: { type: String as PropType<string | null>, default: null },
    streak: { type: Number, default: 0 },
    coverUrl: { type: String as PropType<string | null>, default: null },
    /** The cover of what is on, which takes over from `coverUrl`. */
    labelUrl: { type: String as PropType<string | null>, default: null },
    /** The plays milestone celebrated so far, engraved on the record. */
    seenPlays: { type: Number, default: 0 },
    playing: { type: Boolean, default: false },
    /** Someone else's page: the name and their log, no total listening time. */
    otherAccount: { type: String as PropType<string | null>, default: null },
    since: { type: String as PropType<string | null>, default: null },
    fresh: { type: String as PropType<Moment['kind'] | null>, default: null },
    /** The record that has just landed on the shelf. */
    landedRecord: { type: Number as PropType<number | null>, default: null },
    /** The sentence under the title. */
    line: { type: String as PropType<string | null>, default: null },
    /** The log the shelf's dates are counted back through, oldest first. */
    timestamps: { type: Array as PropType<number[]>, default: () => [] },
    /** Records already celebrated; null when there is nothing to hold back. */
    seenRecords: { type: Number as PropType<number | null>, default: null },
  },
  data() {
    return { lit: false, reveal: 0, frame: 0, grooveLine: '' }
  },
  computed: {
    appearance() {
      return useAppearanceStore()
    },
    record() {
      return recordProgress(this.plays)
    },
    pressed() {
      return pressedRecords(this.plays, this.timestamps)
    },
    /** The song that is on, or else the top album: backdrop and label alike. */
    nextLine(): string {
      if (this.otherAccount) return ''
      const { remaining, next } = this.record
      return this.$t(
        'stats.heroNext',
        { remaining: this.formatNumber(remaining), next: this.formatNumber(next) },
        remaining,
      )
    },
    backdropUrl(): string | null {
      return this.labelUrl ?? this.coverUrl
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
      return this.line
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
    /** For a moment landing on the figure it is about. The start of it, as
     * the box of a line of text is far wider than what it says. */
    figureRect(figure: 'hours' | 'streak'): { x: number; y: number; size: number } {
      const element = this.$refs[`${figure}Figure`] as HTMLElement | undefined
      if (!element) return this.labelRect()
      const box = element.getBoundingClientRect()
      return { x: box.left + box.height / 2, y: box.top + box.height / 2, size: box.height }
    },
    /** For a full record flying onto the shelf. */
    shelfRect(record: number): { x: number; y: number; size: number } | null {
      return (
        (this.$refs.shelf as InstanceType<typeof StatsShelf> | undefined)?.rectOf(record) ?? null
      )
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
  grid-template-columns: minmax(0, 1fr) auto;
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

/* The app's backdrop crossfade: docs/styleguide.md, Motion. */
.stats-hero-art-enter-active,
.stats-hero-art-leave-active {
  transition: opacity 0.6s;
}

.stats-hero-art-enter-from,
.stats-hero-art-leave-to {
  opacity: 0;
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
  text-wrap: pretty;
  font-size: clamp(1.15rem, 1.7cqi, 1.5rem);
  font-weight: 500;
  line-height: 1.35;
}

.stats-hero__next {
  max-width: 620px;
}

/* One line reserved, so the text beside the record stays put while the
 * pointer moves over it. */
.stats-hero__line {
  min-height: 1.5em;
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

.stats-hero__turntable {
  /* By width, with a ceiling: the hero's height follows the record, and on
   * an ultrawide an uncapped one ran past the bottom of the screen. */
  width: clamp(420px, 48cqi, 780px);
  margin-right: 1%;
}

.stats-hero__record {
  width: 100%;
}

/* The record's centre sits left of the middle of its picture, where the
 * tonearm takes up the rest. */
.stats-hero__shelf {
  width: 84.4%;
  padding-bottom: 22px;
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

  .stats-hero__turntable {
    width: min(100%, 420px);
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
