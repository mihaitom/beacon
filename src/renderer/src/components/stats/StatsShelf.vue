<template>
  <ul v-if="records.length" class="stats-shelf" :aria-label="$t('stats.shelfLabel')">
    <li
      v-for="(pile, pileIndex) in piles"
      :key="pile.tier"
      class="stats-shelf__pile"
      :class="{ 'is-open': open === pile.tier }"
      :style="pileStyle(pile, pileIndex)"
    >
      <div
        v-for="(entry, position) in pile.shown"
        :key="entry.number"
        class="stats-shelf__place"
        :class="{ 'is-waiting': isWaiting(entry) }"
        :style="{ '--n': position }"
      >
        <div class="stats-shelf__drop">
          <button
            type="button"
            class="stats-shelf__disc"
            :class="[`stats-shelf__disc--${entry.tier}`, { 'is-landed': landed === entry.number }]"
            :data-record="entry.number"
            :aria-label="details(entry).join('. ')"
            @pointerdown="touching = $event.pointerType === 'touch'"
            @click="onTap(pile.tier, entry.number)"
          >
            <span class="stats-shelf__vinyl" />
            <span class="stats-shelf__sheen" />
            <span class="stats-shelf__label">{{ shortPlays(entry.holds) }}</span>
            <v-tooltip
              activator="parent"
              location="top"
              :open-delay="TIP_DELAY_MS"
              :open-on-hover="canHover"
              :model-value="tip === entry.number"
              @update:model-value="setTip(entry.number, $event)"
            >
              <span
                v-for="(detail, row) in details(entry)"
                :key="row"
                class="stats-shelf__tip"
                :class="{ 'stats-shelf__tip--title': row === 0 }"
                >{{ detail }}</span
              >
            </v-tooltip>
          </button>
        </div>
      </div>
      <span v-if="pile.total > MAX_SHOWN" class="stats-shelf__count">×{{ pile.total }}</span>
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
// A diamond pile would otherwise grow for ever.
const MAX_SHOWN = 5
// Past the fan's movement: a tooltip placed sooner would point at where the
// record was.
const TIP_DELAY_MS = 280
const SECONDS_PER_DAY = 86400
const DAYS_PER_MONTH = 30.44
// Past this, days stop being something anyone counts in.
const MONTHS_FROM_DAYS = 60

interface Pile {
  tier: RecordTier
  /** The newest, last on top. */
  shown: PressedRecord[]
  /** How many are on it, not counting one still in the air. */
  total: number
}

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
    return {
      VINYLS,
      MAX_SHOWN,
      TIP_DELAY_MS,
      /** A pile fanned out by touch, which has no hover to do it. */
      open: null as RecordTier | null,
      touching: false,
      tip: null as number | null,
      // Fixed at mount: Vuetify binds a tooltip's triggers once. On a phone a
      // tap's emulated hover would otherwise open one over the first tap.
      canHover: window.matchMedia?.('(hover: hover)').matches ?? true,
    }
  },
  computed: {
    piles(): Pile[] {
      const byTier = new Map<RecordTier, PressedRecord[]>()
      for (const record of this.records) {
        byTier.set(record.tier, [...(byTier.get(record.tier) ?? []), record])
      }
      return [...byTier].map(([tier, records]) => ({
        tier,
        shown: records.slice(-MAX_SHOWN),
        total: records.filter((record) => !this.isWaiting(record)).length,
      }))
    },
  },
  mounted() {
    window.addEventListener('pointerdown', this.closeIfOutside)
  },
  beforeUnmount() {
    window.removeEventListener('pointerdown', this.closeIfOutside)
  },
  methods: {
    shortPlays(plays: number): string {
      return plays < 1000 ? String(plays) : `${(plays / 1000).toLocaleString(this.$i18n.locale)}k`
    },
    isWaiting(entry: PressedRecord): boolean {
      return this.seen !== null && entry.number > this.seen
    },
    /** A pile at the edge opens inwards, so its fan stays inside the hero.
     * A lone pile has no neighbours: centred it opens both ways, at the start
     * of the row it can only open away from the edge. */
    pileStyle(pile: Pile, index: number): Record<string, string | number> {
      const count = pile.shown.length
      const isOnly = this.piles.length === 1
      const middle = (1 - count) / 2
      const edge = index === 0 ? 0 : index === this.piles.length - 1 ? 1 - count : middle
      return {
        '--p': index,
        '--count': count,
        '--origin-centred': isOnly ? middle : edge,
        '--origin-start': edge,
        '--vinyl': VINYLS[pile.tier],
      }
    },
    /** The first tap fans the pile out, a tap on a fanned record answers. */
    onTap(tier: RecordTier, record: number): void {
      if (!this.touching) return
      if (this.open === tier) {
        this.tip = this.tip === record ? null : record
      } else {
        this.open = tier
        this.tip = null
      }
    },
    setTip(record: number, shown: boolean): void {
      if (shown) this.tip = record
      else if (this.tip === record) this.tip = null
    },
    closeIfOutside(event: PointerEvent): void {
      if (this.$el.contains?.(event.target as Node)) return
      this.open = null
      this.tip = null
    },
    details(entry: PressedRecord): string[] {
      const format = (value: number): string => value.toLocaleString(this.$i18n.locale)
      const rows = [
        this.$t(`stats.tiers.${entry.tier}`),
        this.$t('stats.shelfPlays', { n: format(entry.holds), step: format(entry.step) }),
        entry.earnedAt === null
          ? this.$t('stats.shelfBeforeLog', { total: format(entry.plays) })
          : this.$t('stats.shelfDate', {
              total: format(entry.plays),
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
  /* Sized so five full piles still fit a phone. */
  --disc: clamp(42px, 4.4cqi, 68px);
  --rim: clamp(3px, 0.8cqi, 9px);
  --fan-step: calc(var(--disc) + 8px);
  display: flex;
  justify-content: center;
  gap: clamp(6px, 1.6cqi, 22px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.stats-shelf__pile {
  --fan: 0;
  --origin: var(--origin-centred);
  position: relative;
  flex: 0 1 calc(var(--disc) + (var(--count) - 1) * var(--rim));
  min-width: 0;
  height: var(--disc);
  transition: opacity 0.2s;
}

/* Left-aligned beside the display, centred under the record on a phone. */
@container (min-width: 761px) {
  .stats-shelf {
    justify-content: flex-start;
  }

  .stats-shelf__pile {
    --origin: var(--origin-start);
  }
}

/* Through a custom property, so hover, keyboard and touch share one layout. */
@media (hover: hover) {
  .stats-shelf__pile:hover {
    --fan: 1;
  }

  .stats-shelf:has(.stats-shelf__pile:hover) .stats-shelf__pile:not(:hover) {
    opacity: 0.2;
  }
}

.stats-shelf__pile:has(:focus-visible),
.stats-shelf__pile.is-open {
  --fan: 1;
}

.stats-shelf:has(.is-open) .stats-shelf__pile:not(.is-open) {
  opacity: 0.2;
}

.stats-shelf__pile:hover,
.stats-shelf__pile:has(:focus-visible),
.stats-shelf__pile.is-open {
  z-index: 1;
}

/* Bridges the gaps between fanned records, or the pointer crossing one would
 * close the fan under it. */
.stats-shelf__pile::before {
  content: '';
  position: absolute;
  top: -14px;
  bottom: 0;
  left: calc(var(--origin) * var(--fan-step));
  width: calc(var(--fan) * var(--count) * var(--fan-step));
}

.stats-shelf__place {
  position: absolute;
  inset: 0 auto auto 0;
  transform: translate(
    calc(
      (1 - var(--fan)) * var(--n) * var(--rim) + var(--fan) * (var(--n) + var(--origin)) *
        var(--fan-step)
    ),
    calc((1 - var(--fan)) * var(--n) * -1.5px - var(--fan) * 8px)
  );
  transition: transform 0.26s cubic-bezier(0.2, 0.9, 0.3, 1.15);
}

/* Still in the air during the moment that announces it. */
.stats-shelf__place.is-waiting {
  visibility: hidden;
}

.stats-shelf__drop {
  /* After the tonearm has set down, pile by pile, each dealt from the bottom. */
  animation: stats-shelf-in 0.6s cubic-bezier(0.2, 0.9, 0.3, 1.25) both;
  animation-delay: calc(0.9s + var(--p) * 0.14s + var(--n) * 0.07s);
}

@keyframes stats-shelf-in {
  from {
    opacity: 0;
    transform: translateY(-34px) scale(0.55);
  }
}

.stats-shelf__count {
  position: absolute;
  top: -8px;
  right: -8px;
  z-index: 1;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #2a2420;
  background: #f1e9db;
  opacity: calc(1 - var(--fan));
  pointer-events: none;
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
  .stats-shelf__drop,
  .stats-shelf__disc.is-landed {
    animation: none;
  }

  .stats-shelf__pile,
  .stats-shelf__place,
  .stats-shelf__disc,
  .stats-shelf__label {
    transition: none;
  }
}
</style>
