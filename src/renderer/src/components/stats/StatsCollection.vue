<template>
  <section>
    <h2 class="section-title stats-collection__heading">{{ $t('stats.collectionTitle') }}</h2>
    <div class="stats-collection">
      <div class="beacon-panel">
        <h3 class="eyebrow-label panel-title">{{ $t('stats.inventoryTitle') }}</h3>
        <dl class="stats-collection__facts">
          <div v-for="fact in facts" :key="fact.label">
            <dd>{{ fact.value }}</dd>
            <dt class="text-body-small text-medium-emphasis">{{ fact.label }}</dt>
          </div>
        </dl>
      </div>

      <stats-tips v-if="decades.length" class="beacon-panel">
        <h3 class="eyebrow-label panel-title">{{ $t('stats.decadesTitle') }}</h3>
        <div class="stats-collection__decades">
          <div
            v-for="(decade, index) in decades"
            :key="decade.id"
            class="stats-collection__decade"
            :class="{ 'stats-collection__decade--peak': decade.value === maxDecade }"
            :data-tip="`${decade.label}: ${decade.valueLabel}`"
          >
            <span class="stats-collection__bar" :style="{ height: `${barHeight(decade)}%` }" />
            <em>{{ decadeLabelShown(index) ? decade.label : '' }}</em>
          </div>
        </div>
      </stats-tips>

      <stats-tips v-if="quality.length" class="beacon-panel">
        <h3 class="eyebrow-label panel-title">{{ $t('stats.qualityTitle') }}</h3>
        <div class="stats-collection__quality">
          <span
            v-for="(entry, index) in quality"
            :key="entry.id"
            :class="`stats-collection__step--${index}`"
            :style="{ flexGrow: entry.value }"
            :data-tip="`${entry.label}: ${entry.valueLabel}`"
          />
        </div>
        <div class="stats-collection__legends">
          <div v-for="(entry, index) in quality" :key="entry.id" class="stats-collection__legend">
            <i :class="`stats-collection__step--${index}`" />
            <span>{{ entry.label }}</span>
            <b>{{ entry.valueLabel }}</b>
          </div>
        </div>
        <p
          v-if="formats.length"
          class="text-body-small text-medium-emphasis stats-collection__formats"
        >
          {{
            $t('stats.formatsLine', {
              list: formats.map((f) => `${f.label} ${f.valueLabel}`).join(', '),
            })
          }}
        </p>
      </stats-tips>
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { ChartItem } from './StatsCharts.vue'
import StatsTips from './StatsTips.vue'

// Past this many a panel beside two others has no room for every name, so
// every other one goes (counted from the newest); the tooltip still has them.
const ALL_DECADE_LABELS = 7

// Under the panel's height, leaving room for the decade's name below the bar.
const TALLEST_BAR = 82

export default {
  name: 'StatsCollection',
  components: { StatsTips },
  props: {
    facts: { type: Array as PropType<{ value: string; label: string }[]>, required: true },
    decades: { type: Array as PropType<ChartItem[]>, default: () => [] },
    quality: { type: Array as PropType<ChartItem[]>, default: () => [] },
    formats: { type: Array as PropType<ChartItem[]>, default: () => [] },
  },
  computed: {
    maxDecade(): number {
      return Math.max(1, ...this.decades.map((decade) => decade.value))
    },
  },
  methods: {
    decadeLabelShown(index: number): boolean {
      if (this.decades.length <= ALL_DECADE_LABELS) return true
      return (this.decades.length - 1 - index) % 2 === 0
    },
    barHeight(decade: ChartItem): number {
      return (decade.value / this.maxDecade) * TALLEST_BAR
    },
  },
}
</script>

<style scoped>
.stats-collection__heading {
  margin-bottom: 16px;
}

.stats-collection {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
  gap: 14px;
}

.stats-collection__facts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px 18px;
}

.stats-collection__facts dd {
  margin: 0;
  font-size: 1.4rem;
  font-weight: 700;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}

.stats-collection__decades {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 150px;
}

.stats-collection__decade {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  min-width: 0;
  height: 100%;
}

.stats-collection__decade em {
  min-height: 1.3em;
  font-size: 0.72rem;
  font-style: normal;
  white-space: nowrap;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.stats-collection__bar {
  display: block;
  width: 100%;
  max-width: 44px;
  border-radius: 4px 4px 0 0;
  background: rgba(var(--v-theme-primary), 0.55);
}

.stats-collection__decade:hover .stats-collection__bar,
.stats-collection__decade--peak .stats-collection__bar {
  background: rgb(var(--v-theme-primary));
}

.stats-collection__quality {
  display: flex;
  gap: 2px;
  height: 14px;
  margin-bottom: 14px;
}

.stats-collection__quality span {
  display: block;
  flex-basis: 0;
  border-radius: 4px;
}

/* Ordered, best first, so one colour stepped down rather than three hues. */
.stats-collection__step--0 {
  background: rgb(var(--v-theme-primary));
}

.stats-collection__step--1 {
  background: rgba(var(--v-theme-primary), 0.6);
}

.stats-collection__step--2 {
  background: rgba(var(--v-theme-primary), 0.28);
}

.stats-collection__legend {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 9px;
}

.stats-collection__legend i {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.stats-collection__legend b {
  margin-left: auto;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.stats-collection__formats {
  margin-top: 14px;
}

/* The same width at which the page goes to two columns. Three panels stretched
 * over it left an orphaned row of facts and a label a screen away from its
 * percentage. */
@container stats-page (min-width: 2000px) {
  .stats-collection {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1fr);
  }

  .stats-collection__facts {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .stats-collection__quality {
    height: 22px;
  }

  .stats-collection__legends {
    display: grid;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    gap: 18px;
  }

  .stats-collection__legend {
    margin-top: 0;
  }

  .stats-collection__legend b {
    margin-left: 0;
  }
}
</style>
