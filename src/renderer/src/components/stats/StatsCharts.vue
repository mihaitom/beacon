<template>
  <section class="stats-charts">
    <div class="stats-charts__head">
      <h2 class="section-title">{{ $t('stats.chartsTitle') }}</h2>
      <v-btn-toggle
        v-model="tab"
        mandatory
        class="beacon-view-toggle beacon-view-toggle--text"
        :aria-label="$t('stats.chartsTitle')"
      >
        <v-btn v-for="key in tabs" :key="key" :value="key">{{ $t(`stats.${key}`) }}</v-btn>
      </v-btn-toggle>
    </div>
    <p v-if="since" class="text-body-small text-medium-emphasis stats-charts__since">
      {{ $t('stats.chartsSince', { date: since }) }}
    </p>

    <div v-if="first" class="beacon-panel stats-charts__panel">
      <component :is="first.to ? 'router-link' : 'div'" :to="first.to" class="stats-charts__first">
        <div v-if="first.coverArtId !== undefined" class="stats-charts__cover">
          <cover-art :cover-art-id="first.coverArtId" :image-url="first.imageUrl" size="100%" />
        </div>
        <div>
          <p class="stats-charts__name">{{ first.label }}</p>
          <p v-if="first.sublabel" class="text-body-medium text-medium-emphasis">
            {{ first.sublabel }}
          </p>
        </div>
        <p>
          <span class="stats-charts__plays">{{ first.valueLabel }}</span>
          <span class="text-medium-emphasis">{{ $t('stats.totalPlays') }}</span>
        </p>
      </component>

      <div class="beacon-list">
        <component
          :is="item.to ? 'router-link' : 'div'"
          v-for="(item, index) in rest"
          :key="item.id"
          :to="item.to"
          class="stats-charts__row"
          :class="{ 'stats-charts__row--bare': item.coverArtId === undefined }"
        >
          <span class="stats-charts__rank text-medium-emphasis">{{ index + 2 }}</span>
          <cover-art
            v-if="item.coverArtId !== undefined"
            :cover-art-id="item.coverArtId"
            :image-url="item.imageUrl"
            :size="40"
          />
          <div class="stats-charts__text">
            <div class="stats-charts__title">{{ item.label }}</div>
            <div
              v-if="item.sublabel"
              class="stats-charts__title text-body-small text-medium-emphasis"
            >
              {{ item.sublabel }}
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
        </component>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from '@/components/library/CoverArt.vue'

export interface ChartItem {
  id: string
  label: string
  sublabel?: string
  value: number
  valueLabel: string
  to?: string
  /** undefined: this kind has no artwork, so no column is kept for it. null:
   * it has, and it is not known yet. */
  coverArtId?: string | null
  imageUrl?: string | null
  /** Places climbed (negative: fallen) in the last 30 days. */
  move?: number
}

export type ChartKind = 'songs' | 'artists' | 'albums' | 'genres'

export default {
  name: 'StatsCharts',
  components: { CoverArt },
  props: {
    charts: { type: Object as PropType<Record<ChartKind, ChartItem[]>>, required: true },
    /** The date a chart counted from the log starts at. */
    since: { type: String as PropType<string | null>, default: null },
  },
  data() {
    return {
      tab: 'songs' as ChartKind,
      tabs: ['songs', 'artists', 'albums', 'genres'] as ChartKind[],
    }
  },
  computed: {
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
}

.stats-charts__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 24px;
  margin-bottom: 16px;
}

.stats-charts__since {
  margin: -8px 0 12px;
}

.stats-charts__panel {
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
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  color: inherit;
  text-decoration: none;
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
  display: grid;
  grid-template-columns: 24px 40px minmax(0, 1fr) 76px;
  align-items: center;
  gap: 12px;
  padding: 7px 8px;
  border-radius: 8px;
  color: inherit;
  text-decoration: none;
  transition: background 0.15s;
}

.stats-charts__row--bare {
  grid-template-columns: 24px minmax(0, 1fr) 76px;
}

a.stats-charts__row:hover {
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
