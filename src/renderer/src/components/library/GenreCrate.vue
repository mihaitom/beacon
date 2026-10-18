<template>
  <router-link
    :to="`/genres/${encodeURIComponent(genre.name)}`"
    class="genre-crate"
    @mouseenter="browsing = true"
    @mouseleave="browsing = false"
    @focus="browsing = true"
    @blur="browsing = false"
  >
    <div class="genre-crate__text">
      <span class="genre-crate__name">{{ genre.name }}</span>
      <!-- Two figures that may each take a line of their own: in a narrow
       - crate one sentence broke after its middle dot. -->
      <span class="genre-crate__meta">
        <span
          >{{ $n(genre.albumCount) }}
          {{ genre.albumCount === 1 ? $t('library.album1') : $t('library.albumsN') }}</span
        >
        <span
          >{{ $n(genre.songCount) }}
          {{ genre.songCount === 1 ? $t('library.song1') : $t('library.songsN') }}</span
        >
      </span>
    </div>
    <!-- Pointing at the crate flips through it (see RecordStack.vue). Only
     - the records move; the tile itself stays put, since a tile that lifted
     - on hover flickered under a pointer sweeping across the grid. -->
    <div class="genre-crate__stack">
      <record-stack :covers="covers" :size="COVER_SIZE" :browsing="browsing" />
    </div>
  </router-link>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import RecordStack from './RecordStack.vue'
import type { Genre } from '@/types/library'

/** One record's edge. */
const COVER_SIZE = 140

export default {
  name: 'GenreCrate',
  components: { RecordStack },
  props: {
    genre: {
      type: Object as PropType<Genre>,
      required: true,
    },
    /** Cover art ids from this genre's albums, front first - more than
     * fit in the crate, so flipping through it has records to show. */
    covers: {
      type: Array as PropType<string[]>,
      default: () => [],
    },
  },
  data() {
    return { COVER_SIZE, browsing: false }
  },
}
</script>

<style scoped>
.genre-crate {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  /* The front record whole, the three behind it at their browsing rise
   * (see RecordStack.vue), with room above and below. */
  height: 240px;
  padding: 20px 24px 18px 24px;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--beacon-hairline);
  background:
    radial-gradient(120% 90% at 100% 100%, rgba(245, 169, 78, 0.07), transparent 60%),
    rgb(var(--v-theme-surface));
  color: inherit;
  text-decoration: none;
  transition: border-color 0.2s ease;
}

.genre-crate:hover {
  border-color: rgba(245, 169, 78, 0.4);
}

.genre-crate:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.genre-crate__text {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding-bottom: 6px;
  align-self: flex-end;
}

.genre-crate__name {
  font-size: 1.35rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.15;
  /* Whole words to the next line, never a word split in two. */
  overflow-wrap: break-word;
  hyphens: auto;
  transition: color 0.2s ease;
}

.genre-crate:hover .genre-crate__name {
  color: rgb(var(--v-theme-primary));
}

.genre-crate__meta {
  display: flex;
  flex-wrap: wrap;
  column-gap: 12px;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.55);
  font-variant-numeric: tabular-nums;
}

.genre-crate__stack {
  position: relative;
  flex: 0 0 auto;
}

@media (prefers-reduced-motion: reduce) {
  .genre-crate__name {
    transition: none;
  }
}
</style>
