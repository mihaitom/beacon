<template>
  <div class="ranked-list">
    <component
      :is="item.to ? 'router-link' : 'div'"
      v-for="(item, index) in items"
      :key="item.id"
      :to="item.to"
      class="ranked-list__row"
    >
      <span class="ranked-list__rank text-medium-emphasis">{{ index + 1 }}</span>
      <cover-art
        v-if="item.coverArtId !== undefined"
        :cover-art-id="item.coverArtId"
        :image-url="item.imageUrl"
        :size="32"
        class="ranked-list__cover"
      />
      <div class="ranked-list__info">
        <div class="text-body-2 text-truncate">{{ item.label }}</div>
        <div v-if="item.sublabel" class="text-caption text-medium-emphasis text-truncate">
          {{ item.sublabel }}
        </div>
        <div class="ranked-list__bar-song">
          <div class="ranked-list__bar-fill" :style="{ width: `${barWidth(item)}%` }" />
        </div>
      </div>
      <span class="ranked-list__value text-caption text-medium-emphasis">{{
        item.valueLabel
      }}</span>
    </component>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from './CoverArt.vue'

export interface RankedItem {
  id: string
  label: string
  sublabel?: string | null
  // What the bar length is proportional to — the display text (valueLabel)
  // is separate since it's often a different unit/rounding than what
  // ranking should actually go by (e.g. StatsView.vue's format breakdown
  // ranks by raw song count but displays a rounded percentage).
  value: number
  valueLabel: string
  to?: string | null
  // undefined (the field simply omitted) hides the art column entirely for
  // that whole list — StatsView.vue's format/decade breakdowns have no
  // meaningful per-item cover to show. null is still a real "no art for
  // *this* item" case within a list that otherwise has it (e.g. an artist
  // Navidrome has no photo for), same as CoverArt.vue's own coverArtId prop.
  coverArtId?: string | null
  // Real artist photo (e.g. Navidrome's artistImageUrl), preferred over
  // coverArtId when both are given — see CoverArt.vue's own imageUrl prop.
  // Only ever set alongside a defined coverArtId (StatsView.vue's top
  // artists, looked up from libraryStore.artists rather than derived from
  // any one song — a song's own cover is its *album's* art, not the
  // artist's); every other caller leaves this undefined.
  imageUrl?: string | null
}

// Single-hue magnitude encoding (one ranked series at a time — never
// several on the same list), not a categorical palette: no CVD-safe hue
// separation to validate here, see dataviz skill's choosing-a-form.md.
// Reuses the app's own existing amber accent rather than introducing a
// second one.
export default {
  name: 'RankedList',
  components: { CoverArt },
  props: {
    items: {
      type: Array as PropType<RankedItem[]>,
      required: true,
    },
  },
  computed: {
    maxValue(): number {
      // Callers already sort descending (StatsView.vue's aggregation
      // helpers) — the first item is the longest bar's reference, not
      // necessarily the actual max if a caller ever passes unsorted data,
      // but every current caller does sort, and computing a real max here
      // for hundreds of rows on every render is needless work this avoids.
      return this.items[0]?.value ?? 0
    },
  },
  methods: {
    barWidth(item: RankedItem): number {
      if (this.maxValue <= 0) return 0
      return Math.max(4, (item.value / this.maxValue) * 100)
    },
  },
}
</script>

<style scoped>
.ranked-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ranked-list__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  text-decoration: none;
  color: inherit;
}

/* Only router-link rows are actually clickable (plain <div> rows — top
 * songs, format breakdown — have nothing to link to) — no hover tint on
 * those so they don't read as interactive when they aren't. */
a.ranked-list__row:hover {
  background: var(--beacon-hover);
}

.ranked-list__rank {
  flex: 0 0 20px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.ranked-list__cover {
  flex-shrink: 0;
}

/* flex-grow so every row's info column ends up the exact same width
 * (whatever's left next to the fixed-width rank/value columns) regardless
 * of how long that row's own label happens to be — .ranked-list__bar-fill
 * below is a % of *this* box, so without this a longer label (which
 * without a grow value otherwise sizes the box to fit its own content,
 * not the row) made its own bar render visibly longer in absolute pixels
 * than a shorter-labeled row at the very same or even a higher value. */
.ranked-list__info {
  flex: 1 1 0%;
  min-width: 0;
}

.ranked-list__bar-song {
  margin-top: 6px;
  height: 4px;
  border-radius: 2px;
  background: var(--beacon-hairline);
  overflow: hidden;
}

.ranked-list__bar-fill {
  height: 100%;
  border-radius: 2px;
  background: rgb(var(--v-theme-primary));
  transition: width 0.6s ease;
}

.ranked-list__value {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
