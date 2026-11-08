<template>
  <ul v-if="records.length" class="stats-shelf" :aria-label="$t('stats.shelfLabel')">
    <li
      v-for="(entry, index) in records"
      :key="entry.number"
      class="stats-shelf__slot"
      :class="{ 'is-waiting': seen !== null && entry.number > seen }"
      :style="{ '--i': index, '--vinyl': VINYLS[entry.tier] }"
    >
      <button
        type="button"
        class="stats-shelf__disc"
        :class="[`stats-shelf__disc--${entry.tier}`, { 'is-landed': landed === entry.number }]"
        :data-record="entry.number"
        :aria-label="details(entry).join('. ')"
      >
        <span class="stats-shelf__vinyl" />
        <span class="stats-shelf__sheen" />
        <span class="stats-shelf__label">{{ shortPlays(entry.plays) }}</span>
        <v-tooltip activator="parent" location="top" open-on-click>
          <span
            v-for="(detail, row) in details(entry)"
            :key="row"
            class="stats-shelf__tip"
            :class="{ 'stats-shelf__tip--title': row === 0 }"
            >{{ detail }}</span
          >
        </v-tooltip>
      </button>
    </li>
  </ul>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { PressedRecord, RecordTier } from '@/services/library/statsMilestones'

// Objects, the same on every theme (docs/styleguide.md).
const VINYLS: Record<RecordTier, string> = {
  bronze: '#a76a3a',
  silver: '#8d96a4',
  gold: '#dba92f',
  platinum: '#d5deea',
  diamond: '#bfe7ff',
}
const SECONDS_PER_DAY = 86400
const DAYS_PER_MONTH = 30.44
// Past this, days stop being something anyone counts in.
const MONTHS_FROM_DAYS = 60

export default {
  name: 'StatsShelf',
  props: {
    records: { type: Array as PropType<PressedRecord[]>, required: true },
    /** Records already celebrated: one past that is still on its way here. */
    seen: { type: Number as PropType<number | null>, default: null },
    /** The record that has just arrived. */
    landed: { type: Number as PropType<number | null>, default: null },
  },
  data() {
    return { VINYLS }
  },
  methods: {
    shortPlays(plays: number): string {
      return plays < 1000 ? String(plays) : `${plays / 1000}k`
    },
    details(entry: PressedRecord): string[] {
      const format = (value: number): string => value.toLocaleString(this.$i18n.locale)
      const rows = [
        this.$t(`stats.tiers.${entry.tier}`),
        this.$t('stats.shelfPlays', { n: format(entry.plays), step: format(entry.step) }),
        entry.earnedAt === null
          ? this.$t('stats.shelfBeforeLog')
          : this.$t('stats.shelfDate', {
              date: new Date(entry.earnedAt * 1000).toLocaleDateString(this.$i18n.locale, {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              }),
            }),
      ]
      const took = this.took(entry.tookSeconds)
      return took ? [...rows, took] : rows
    },
    took(seconds: number | null): string | null {
      if (seconds === null) return null
      const days = Math.round(seconds / SECONDS_PER_DAY)
      if (days < 2) return null
      if (days < MONTHS_FROM_DAYS) return this.$t('stats.shelfDays', { n: days })
      return this.$t('stats.shelfMonths', { n: Math.round(days / DAYS_PER_MONTH) })
    },
    /** Where a full record flying in should land. */
    rectOf(record: number): { x: number; y: number; size: number } | null {
      const disc = this.$el.querySelector?.(`[data-record="${record}"]`) as HTMLElement | null
      if (!disc) return null
      const box = disc.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, size: box.width }
    },
  },
}
</script>

<style scoped>
.stats-shelf {
  --disc: clamp(46px, 4.4cqi, 68px);
  display: flex;
  justify-content: center;
  margin: 0;
  padding: 0;
  list-style: none;
}

.stats-shelf__slot {
  /* One row however many there are: the slots shrink and the records overlap,
   * where a second row would push the hero off the screen. */
  position: relative;
  flex: 0 1 calc(var(--disc) + 14px);
  min-width: 0;
  /* After the tonearm has set down, one after the other. */
  animation: stats-shelf-in 0.65s cubic-bezier(0.2, 0.9, 0.3, 1.25) both;
  animation-delay: calc(0.9s + var(--i) * 0.1s);
}

.stats-shelf__slot:hover,
.stats-shelf__slot:focus-within {
  z-index: 1;
}

/* Still in the air during the moment that announces it. */
.stats-shelf__slot.is-waiting {
  visibility: hidden;
}

@keyframes stats-shelf-in {
  from {
    opacity: 0;
    transform: translateY(-34px) scale(0.55);
  }
}

.stats-shelf__disc {
  position: relative;
  display: block;
  width: var(--disc);
  aspect-ratio: 1;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: none;
  cursor: default;
  filter: drop-shadow(0 5px 8px rgba(0, 0, 0, 0.55));
  transition:
    transform 0.32s cubic-bezier(0.2, 0.9, 0.3, 1.3),
    filter 0.32s;
}

.stats-shelf__disc:hover,
.stats-shelf__disc:focus-visible {
  transform: translateY(-7px) scale(1.14);
  filter: drop-shadow(0 8px 14px color-mix(in srgb, var(--vinyl) 70%, transparent));
}

.stats-shelf__disc:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 3px;
}

.stats-shelf__disc.is-landed {
  animation: stats-shelf-landed 0.9s ease-out;
}

@keyframes stats-shelf-landed {
  from {
    transform: scale(1.5);
    filter: brightness(2) drop-shadow(0 0 18px var(--vinyl));
  }
}

.stats-shelf__vinyl,
.stats-shelf__sheen,
.stats-shelf__label {
  position: absolute;
  border-radius: 50%;
}

.stats-shelf__vinyl,
.stats-shelf__sheen {
  inset: 0;
}

.stats-shelf__vinyl {
  background:
    repeating-radial-gradient(circle, rgba(0, 0, 0, 0.2) 0 1px, transparent 1px 3px),
    radial-gradient(
      circle,
      color-mix(in srgb, var(--vinyl) 92%, white),
      color-mix(in srgb, var(--vinyl) 62%, black)
    );
}

/* Apart from the vinyl: the light in the room stays put while the record
 * turns under it. */
.stats-shelf__sheen {
  background: conic-gradient(
    from 25deg,
    transparent 0 6%,
    rgba(255, 255, 255, 0.3) 11%,
    transparent 17% 55%,
    rgba(255, 255, 255, 0.22) 61%,
    transparent 67%
  );
}

/* What sets a diamond apart: the foil of the rarest ring on the record. */
.stats-shelf__disc--diamond .stats-shelf__vinyl {
  background:
    repeating-radial-gradient(circle, rgba(0, 0, 0, 0.14) 0 1px, transparent 1px 3px),
    conic-gradient(#9fe3ff, #e2c2ff, #ffc9e5, #fff0b8, #b8ffdf, #9fe3ff);
}

/* One whole turn there and one back, so it always comes to rest upright. */
.stats-shelf__label {
  inset: 29%;
  display: grid;
  place-items: center;
  font-size: clamp(0.55rem, 0.75cqi, 0.72rem);
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: #2a2420;
  background: #f1e9db;
  transition: transform 0.75s cubic-bezier(0.3, 0.7, 0.2, 1);
}

.stats-shelf__disc:hover .stats-shelf__label,
.stats-shelf__disc:focus-visible .stats-shelf__label {
  transform: rotate(360deg);
}

.stats-shelf__tip {
  display: block;
}

.stats-shelf__tip--title {
  font-weight: 700;
}

@media (prefers-reduced-motion: reduce) {
  .stats-shelf__slot,
  .stats-shelf__disc.is-landed {
    animation: none;
  }

  .stats-shelf__disc,
  .stats-shelf__label {
    transition: none;
  }
}
</style>
