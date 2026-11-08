<template>
  <section class="stats-year__section">
    <h2 class="section-title stats-year__heading">{{ $t('stats.yearTitle') }}</h2>
    <p v-if="importing" class="text-body-medium text-medium-emphasis stats-year__notice">
      <v-progress-circular indeterminate size="16" width="2" color="primary" />
      {{
        $t('stats.importRunning', {
          source: sourceName(importStatus?.source),
          n: formatNumber(importStatus?.fetched ?? 0),
        })
      }}
    </p>
    <div v-else-if="importOffer" class="stats-year__notice">
      <span class="text-body-medium text-medium-emphasis">{{ importOfferText }}</span>
      <v-btn
        v-for="option in options"
        :key="option.source"
        variant="tonal"
        color="primary"
        size="small"
        @click="$emit('start-import', option)"
      >
        {{ sourceName(option.source) }}
      </v-btn>
    </div>

    <p v-if="timestamps.length === 0" class="text-body-medium text-medium-emphasis">
      {{ $t('stats.yearEmpty') }}
    </p>
    <stats-tips v-else class="beacon-panel stats-year">
      <div class="stats-year__streak">
        <div class="stats-year__count">
          <v-icon icon="mdi-fire" size="40" color="primary" />
          {{ formatNumber(streak.current) }}
        </div>
        <p class="text-body-medium text-medium-emphasis">
          {{ $t('stats.streakRecord', { record: formatNumber(streak.longest) }, streak.current) }}
        </p>
      </div>

      <div class="stats-year__calendar">
        <div class="stats-year__weeks">
          <div
            v-for="(week, index) in year"
            :key="index"
            class="stats-year__week"
            :class="{ 'stats-year__week--older': index < olderThan }"
          >
            <span class="stats-year__month">{{ monthName(week.month) }}</span>
            <template v-for="(day, dayIndex) in week.days" :key="dayIndex">
              <div
                v-if="day"
                class="stats-year__day"
                :class="`stats-year__day--${day.level}`"
                :data-tip="dayTip(day)"
              />
              <div v-else class="stats-year__day stats-year__day--future" />
            </template>
          </div>
        </div>
        <div class="stats-year__legend">
          {{ $t('stats.less') }}
          <span v-for="level in 5" :key="level" :class="`stats-year__day--${level - 1}`" />
          {{ $t('stats.more') }}
        </div>
      </div>

      <div>
        <p class="stats-year__peak">{{ $t('stats.peakHour', { hour: hourName(peakHour) }) }}</p>
        <div class="stats-year__hours">
          <div
            v-for="(count, hour) in hours"
            :key="hour"
            class="stats-year__hour"
            :class="{ 'stats-year__hour--peak': hour === peakHour }"
            :data-tip="`${hourName(hour)}: ${formatNumber(count)}`"
          >
            <span :style="{ height: `${(count / maxHour) * 100}%` }" />
          </div>
        </div>
        <div class="stats-year__axis text-medium-emphasis">
          <span v-for="hour in axisHours" :key="hour" :style="{ gridColumnStart: hour + 1 }">
            {{ hour }}
          </span>
        </div>
      </div>
    </stats-tips>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import {
  buildYear,
  playsByHour,
  type YearDay,
  type YearWeek,
} from '@/services/library/listeningYear'
import type { ImportOption, ImportSource } from '@/services/library/playHistoryImport'
import type { PlayHistoryImportStatus } from '@/services/connect/playHistory'
import StatsTips from './StatsTips.vue'

// Weeks that still fit on a phone; the rest are hidden by a container query.
const NARROW_WEEKS = 22
const WEEKS = 53

const SOURCE_NAMES: Record<ImportSource, string> = {
  lastfm: 'Last.fm',
  listenbrainz: 'ListenBrainz',
}

export default {
  name: 'StatsYear',
  components: { StatsTips },
  props: {
    timestamps: { type: Array as PropType<number[]>, required: true },
    streak: { type: Object as PropType<{ current: number; longest: number }>, required: true },
    today: { type: Date, required: true },
    importStatus: {
      type: Object as PropType<PlayHistoryImportStatus | null>,
      default: null,
    },
    /** Profiles to offer: two to choose from, or the ones to try again. */
    options: { type: Array as PropType<ImportOption[]>, default: () => [] },
  },
  emits: ['start-import'],
  data() {
    return { axisHours: [0, 6, 12, 18], olderThan: WEEKS - NARROW_WEEKS }
  },
  computed: {
    year(): YearWeek[] {
      return buildYear(this.timestamps, this.today, WEEKS)
    },
    hours(): number[] {
      return playsByHour(this.timestamps)
    },
    maxHour(): number {
      return Math.max(1, ...this.hours)
    },
    peakHour(): number {
      return this.hours.indexOf(Math.max(...this.hours))
    },
    importing(): boolean {
      return this.importStatus?.status === 'running'
    },
    importOffer(): boolean {
      return this.options.length > 0
    },
    importOfferText(): string {
      if (this.importStatus?.status !== 'failed') return this.$t('stats.importChoose')
      const source = this.sourceName(this.importStatus.source)
      return this.importStatus.error === 'not_found'
        ? this.$t('stats.importNotFound', { source })
        : this.$t('stats.importFailed', { source })
    },
  },
  methods: {
    sourceName(source: ImportSource | undefined): string {
      return source ? SOURCE_NAMES[source] : ''
    },
    formatNumber(value: number): string {
      return value.toLocaleString(this.$i18n.locale)
    },
    monthName(month: number | null): string {
      if (month === null) return ''
      return new Intl.DateTimeFormat(this.$i18n.locale, { month: 'short' }).format(
        new Date(2000, month, 1),
      )
    },
    hourName(hour: number): string {
      return new Intl.DateTimeFormat(this.$i18n.locale, { hour: 'numeric' }).format(
        new Date(2000, 0, 1, hour),
      )
    },
    dayTip(day: YearDay): string {
      const date = new Intl.DateTimeFormat(this.$i18n.locale, {
        day: 'numeric',
        month: 'short',
      }).format(day.date)
      return day.count
        ? this.$t('stats.dayTip', { date, n: this.formatNumber(day.count) }, day.count)
        : this.$t('stats.dayNothing', { date })
    },
  },
}
</script>

<style scoped>
.stats-year__heading {
  margin-bottom: 16px;
}

.stats-year__notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

/* On the section: a container query cannot restyle its own container. */
.stats-year__section {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
}

.stats-year {
  flex: 1;
  align-content: center;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 28px;
}

@container (min-width: 1100px) {
  .stats-year {
    grid-template-columns: 180px minmax(0, 1fr) 240px;
    align-items: start;
  }
}

.stats-year__count {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 4rem;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}

.stats-year__weeks {
  display: flex;
  gap: 3px;
}

.stats-year__week {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

@container (max-width: 620px) {
  .stats-year__week--older {
    display: none;
  }
}

/* Beside the charts it has height to spare and too little width for three
 * columns, which left a year of days the size of a stamp. */
@container stats-page (min-width: 2000px) {
  .stats-year {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
  }

  .stats-year__calendar {
    grid-row: 2;
    grid-column: 1 / -1;
  }
}

/* Wider than its week: the label runs over the columns beside it. */
.stats-year__month {
  height: 16px;
  overflow: visible;
  font-size: 0.74rem;
  white-space: nowrap;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.stats-year__day {
  aspect-ratio: 1;
  border-radius: 2.5px;
}

.stats-year__day--future {
  background: none;
}

.stats-year__day--0 {
  background: rgba(var(--v-theme-on-surface), 0.05);
}

.stats-year__day--1 {
  background: rgba(var(--v-theme-primary), 0.25);
}

.stats-year__day--2 {
  background: rgba(var(--v-theme-primary), 0.45);
}

.stats-year__day--3 {
  background: rgba(var(--v-theme-primary), 0.72);
}

.stats-year__day--4 {
  background: rgb(var(--v-theme-primary));
}

.stats-year__legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 8px;
  font-size: 0.74rem;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.stats-year__legend span {
  width: 11px;
  height: 11px;
  border-radius: 2.5px;
}

.stats-year__peak {
  font-weight: 600;
}

.stats-year__hours {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 92px;
  margin-top: 12px;
}

.stats-year__hour {
  display: flex;
  flex: 1 1 0;
  align-items: flex-end;
  min-width: 0;
  height: 100%;
}

.stats-year__hour span {
  display: block;
  width: 100%;
  border-radius: 3px 3px 0 0;
  background: rgba(var(--v-theme-primary), 0.38);
}

.stats-year__hour:hover span,
.stats-year__hour--peak span {
  background: rgb(var(--v-theme-primary));
}

/* The same 24 columns as the bars, so a label stands under its own hour. */
.stats-year__axis {
  display: grid;
  grid-template-columns: repeat(24, minmax(0, 1fr));
  column-gap: 3px;
  margin-top: 5px;
  white-space: nowrap;
  font-size: 0.74rem;
}
</style>
