<template>
  <section class="stats-charts">
    <div class="stats-charts__head">
      <h2 class="section-title">{{ $t('stats.chartsTitle') }}</h2>
      <!-- The shared control row from the library pages: same flat pill
         - surface as a filter row's fields, see base.css. -->
      <div class="library-filter stats-charts__controls">
        <v-select
          v-if="showPeriod"
          :model-value="period"
          :items="periods"
          :aria-label="$t('stats.periodLabel')"
          prepend-inner-icon="mdi-calendar-range"
          density="compact"
          variant="solo-filled"
          rounded="pill"
          flat
          hide-details
          class="stats-charts__period"
          @update:model-value="$emit('update:period', $event)"
        >
          <!-- Every window's name stacked in one cell, only the picked one
             - visible: the pill is as wide as its longest name, so it keeps
             - its width whichever window is on and no name is cut off
             - (same trick as LibrarySortSelect). -->
          <template #selection="{ item }">
            <span class="stats-charts__period-label">
              <span
                v-for="option in periods"
                :key="option.value"
                class="stats-charts__period-name"
                :class="{ 'stats-charts__period-name--shown': option.value === item.value }"
                :aria-hidden="option.value !== item.value"
                >{{ option.title }}</span
              >
            </span>
          </template>
        </v-select>
        <v-btn-toggle
          v-model="tab"
          mandatory
          class="beacon-view-toggle beacon-view-toggle--text stats-charts__tabs"
          :aria-label="$t('stats.chartsTitle')"
        >
          <v-btn v-for="key in tabs" :key="key" :value="key">{{ $t(`stats.${key}`) }}</v-btn>
        </v-btn-toggle>
      </div>
    </div>
    <p v-if="since" class="text-body-small text-medium-emphasis stats-charts__since">
      {{ $t('stats.chartsSince', { date: since }) }}
    </p>

    <div v-if="loading" class="stats-charts__loading">
      <v-progress-circular indeterminate size="28" color="primary" />
    </div>
    <!-- A quiet line rather than the page's empty state: only this window is
       - empty, and the picker above has to stay to leave it again. -->
    <p v-else-if="!items.length" class="text-body-medium text-medium-emphasis">
      {{ $t('stats.chartsEmptyPeriod') }}
    </p>
    <div v-if="first" class="beacon-panel stats-charts__panel">
      <div class="stats-charts__first" @mouseenter="browsing = true" @mouseleave="browsing = false">
        <!-- Over the line rather than around it: the artist names in it are
           - links of their own, and a link cannot hold another. -->
        <router-link
          v-if="first.to"
          :to="first.to"
          :aria-label="first.label"
          class="stats-charts__stretch"
        />
        <record-stack
          v-if="first.covers"
          :covers="first.covers"
          :size="CRATE_SIZE"
          :rise="CRATE_RISE"
          :browsing="browsing"
          fallback-icon="mdi-tag-multiple"
        />
        <div v-else-if="first.coverArtId !== undefined" class="stats-charts__cover">
          <cover-art :cover-art-id="first.coverArtId" :image-url="first.imageUrl" size="100%" />
        </div>
        <div>
          <p class="stats-charts__name">
            <artist-credit
              v-if="tab === 'artists'"
              :credit="first.label"
              :artist-id="first.artistId"
            />
            <template v-else>{{ first.label }}</template>
          </p>
          <p v-if="first.sublabel" class="text-body-medium text-medium-emphasis">
            <artist-credit :credit="first.sublabel" :artist-id="first.artistId" />
          </p>
        </div>
        <p>
          <span class="stats-charts__plays">{{ first.valueLabel }}</span>
          <span class="text-medium-emphasis">{{ $t('stats.totalPlays') }}</span>
        </p>
      </div>

      <div class="beacon-list">
        <div
          v-for="(item, index) in rest"
          :key="item.id"
          class="stats-charts__row"
          :class="{
            'stats-charts__row--bare': item.coverArtId === undefined,
            'stats-charts__row--linked': item.to,
          }"
        >
          <router-link
            v-if="item.to"
            :to="item.to"
            :aria-label="item.label"
            class="stats-charts__stretch"
          />
          <span class="stats-charts__rank text-medium-emphasis">{{ index + 2 }}</span>
          <cover-art
            v-if="item.coverArtId !== undefined"
            :cover-art-id="item.coverArtId"
            :image-url="item.imageUrl"
            :size="40"
          />
          <div class="stats-charts__text">
            <div class="stats-charts__title">
              <artist-credit
                v-if="tab === 'artists'"
                :credit="item.label"
                :artist-id="item.artistId"
              />
              <template v-else>{{ item.label }}</template>
            </div>
            <div
              v-if="item.sublabel"
              class="stats-charts__title text-body-small text-medium-emphasis"
            >
              <artist-credit :credit="item.sublabel" :artist-id="item.artistId" />
            </div>
            <div class="stats-charts__track">
              <div class="stats-charts__fill" :style="{ width: `${share(item)}%` }" />
            </div>
          </div>
          <div class="stats-charts__value">
            {{ item.valueLabel }}
            <span
              v-if="item.move"
              class="stats-charts__move"
              :class="{ 'stats-charts__move--down': item.move < 0 }"
            >
              <v-icon :icon="item.move > 0 ? 'mdi-arrow-up' : 'mdi-arrow-down'" size="12" />
              {{ Math.abs(item.move) }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import ArtistCredit from '@/components/library/ArtistCredit.vue'
import CoverArt from '@/components/library/CoverArt.vue'
import RecordStack from '@/components/library/RecordStack.vue'
import type { PlayHistoryPeriod } from '@/services/connect/playHistory'

// With its rise as tall as the other tabs' cover. The rise has to clear the
// 4% each record behind shrinks by, or only the front one shows.
const CRATE_SIZE = 'min(72cqi, 240px)'
const CRATE_RISE = 22

export interface ChartItem {
  id: string
  label: string
  /** Always an artist credit where there is one. */
  sublabel?: string
  /** The server's id for that credit, or for the artist of an artist line. */
  artistId?: string | null
  value: number
  valueLabel: string
  to?: string
  /** undefined: this kind has no artwork, so no column is kept for it. null:
   * it has, and it is not known yet. */
  coverArtId?: string | null
  imageUrl?: string | null
  /** A kind with no artwork of its own: the number one stands as a crate of
   * its records instead. */
  covers?: string[]
  /** Places climbed (negative: fallen) in the last 30 days. */
  move?: number
}

export type ChartKind = 'songs' | 'artists' | 'albums' | 'genres'

export default {
  name: 'StatsCharts',
  components: { ArtistCredit, CoverArt, RecordStack },
  props: {
    charts: { type: Object as PropType<Record<ChartKind, ChartItem[]>>, required: true },
    /** The date a chart counted from the log starts at. */
    since: { type: String as PropType<string | null>, default: null },
    /** Which window the charts count. */
    period: { type: String as PropType<PlayHistoryPeriod>, default: 'all_time' },
    /** Only once the log has plays in it: before that there is nothing a
     * window could narrow. */
    showPeriod: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
  },
  emits: ['update:period'],
  data() {
    return {
      CRATE_SIZE,
      CRATE_RISE,
      browsing: false,
      tab: 'songs' as ChartKind,
      tabs: ['songs', 'artists', 'albums', 'genres'] as ChartKind[],
    }
  },
  computed: {
    periods(): { title: string; value: PlayHistoryPeriod }[] {
      return [
        { title: this.$t('stats.periodWeek'), value: 'week' },
        { title: this.$t('stats.periodMonth'), value: 'month' },
        { title: this.$t('stats.periodQuarter'), value: 'quarter' },
        { title: this.$t('stats.periodHalfYearly'), value: 'half_yearly' },
        { title: this.$t('stats.periodYear'), value: 'year' },
        { title: this.$t('stats.periodAllTime'), value: 'all_time' },
      ]
    },
    items(): ChartItem[] {
      return this.charts[this.tab]
    },
    first(): ChartItem | undefined {
      return this.items[0]
    },
    rest(): ChartItem[] {
      return this.items.slice(1)
    },
  },
  methods: {
    share(item: ChartItem): number {
      return this.first ? (item.value / this.first.value) * 100 : 0
    },
  },
}
</script>

<style scoped>
/* On the section: a container query cannot restyle its own container. */
.stats-charts {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
}

.stats-charts__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 24px;
  margin-bottom: 16px;
}

/* .library-filter lays the row out; the chart-kind toggle keeps its width
 * while the period pill is the one that gives when space runs out. */
.stats-charts__tabs {
  flex-shrink: 0;
}

/* As wide as its longest window (see the selection slot), giving only in a
 * header too narrow for it beside the toggle. */
.stats-charts__period {
  flex: 0 1 auto;
  min-width: 160px;
}

.stats-charts__period-label {
  display: inline-grid;
  min-width: 0;
}

.stats-charts__period-name {
  grid-area: 1 / 1;
  visibility: hidden;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stats-charts__period-name--shown {
  visibility: visible;
}

.stats-charts__since {
  margin: -8px 0 12px;
}

/* Keeps the header at the panel's own top padding while the answer is in,
 * so the chart area does not jump when it arrives. */
.stats-charts__loading {
  display: flex;
  justify-content: center;
  padding: 48px 0;
}

.stats-charts__panel {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 28px;
}

@container (min-width: 760px) {
  .stats-charts__panel {
    grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
  }
}

.stats-charts__first {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.stats-charts__stretch {
  position: absolute;
  inset: 0;
  border-radius: inherit;
}

.stats-charts__panel :deep(.artist-credit__link) {
  position: relative;
  z-index: 1;
}

.stats-charts__cover {
  width: 100%;
  max-width: 300px;
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 4px;
}

/* A name in the page's one list worth a serif: there is one per chart. */
.stats-charts__name {
  font-family: Georgia, 'Times New Roman', serif;
  font-weight: 600;
  font-size: 1.7rem;
  line-height: 1.12;
  overflow-wrap: anywhere;
}

.stats-charts__plays {
  font-size: 2.3rem;
  font-weight: 700;
  letter-spacing: -0.015em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  margin-right: 8px;
}

.stats-charts__row {
  position: relative;
  display: grid;
  grid-template-columns: 24px 40px minmax(0, 1fr) 76px;
  align-items: center;
  gap: 12px;
  padding: 7px 8px;
  border-radius: 8px;
  transition: background 0.15s;
}

.stats-charts__row--bare {
  grid-template-columns: 24px minmax(0, 1fr) 76px;
}

.stats-charts__row--linked:hover {
  background: var(--beacon-hover);
}

.stats-charts__rank,
.stats-charts__value {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.stats-charts__text {
  min-width: 0;
}

.stats-charts__title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.stats-charts__track {
  height: 3px;
  margin-top: 5px;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(var(--v-theme-on-surface), 0.08);
}

.stats-charts__fill {
  height: 100%;
  border-radius: 2px;
  background: rgba(var(--v-theme-primary), 0.8);
  transition: width 0.6s ease-out;
}

.stats-charts__move {
  display: block;
  font-size: 0.72rem;
  color: rgb(var(--v-theme-success));
}

.stats-charts__move--down {
  color: rgba(var(--v-theme-on-surface), 0.55);
}
</style>
