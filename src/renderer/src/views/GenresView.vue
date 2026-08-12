<template>
  <v-container fluid>
    <sticky-filter>
      <h1 class="page-title mb-4">{{ $t('library.genres') }}</h1>
      <v-text-field
        v-model="filterQuery"
        :label="$t('common.filter')"
        prepend-inner-icon="mdi-filter-variant"
        variant="solo-filled"
        density="compact"
        clearable
        style="max-width: 320px"
      />
    </sticky-filter>
    <v-alert v-if="libraryStore.error" type="error" variant="tonal" class="mb-4">
      {{ libraryStore.error }}
    </v-alert>
    <v-progress-circular v-if="libraryStore.loading" indeterminate class="mb-4" />
    <div v-else-if="tieredGenres.length" class="genre-grid">
      <router-link
        v-for="entry in tieredGenres"
        :key="entry.genre.name"
        :to="`/genres/${encodeURIComponent(entry.genre.name)}`"
        class="genre-tile"
        :class="`genre-tile--${entry.tier}`"
      >
        <span class="genre-tile__name">{{ entry.genre.name }}</span>
        <span class="genre-tile__meta">{{
          $t('library.albumsAndSongs', { albums: entry.genre.albumCount, songs: entry.genre.songCount })
        }}</span>
      </router-link>
    </div>
    <v-alert v-else-if="!libraryStore.loading" type="info" variant="tonal">
      {{
        filterQuery
          ? $t('library.noGenresForQuery', { query: filterQuery })
          : $t('library.noGenresFound')
      }}
    </v-alert>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import StickyFilter from '@/components/StickyFilter.vue'
import type { Genre } from '@/types/library'

let debounceTimer: ReturnType<typeof setTimeout> | undefined

// How many of the top (by songCount) genres the default browse view shows —
// this is a "most-played chart," not a full A-Z index (the library's whole
// genre list can run into the hundreds). 21 = 1 spotlight (2x2) + 4 featured
// (2x1) + 16 standard (1x1) = 28 grid cells exactly, filling all 7 rows of
// the 4-column grid with no trailing gap — see .genre-grid below.
const TOP_COUNT = 21

type Tier = 'spotlight' | 'featured' | 'standard'

export default {
  name: 'GenresView',
  components: { StickyFilter },
  data() {
    return {
      filterQuery: '',
      // filteredGenres reads this instead of filterQuery directly, so
      // filtering doesn't run synchronously on every keystroke — see the
      // identical pattern (and its rationale) in TracksView.vue.
      debouncedQuery: '',
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    isFiltering(): boolean {
      return this.debouncedQuery.trim().length > 0
    },
    // Most-played first — songCount is the only popularity signal
    // getGenres.view gives us.
    sortedGenres(): Genre[] {
      return [...this.libraryStore.genres].sort((a, b) => b.songCount - a.songCount)
    },
    // Top 20 while browsing; searching looks across the *whole* library
    // instead — capping search results to the top 20 would silently hide
    // a real match that just isn't one of the biggest genres.
    filteredGenres(): Genre[] {
      if (!this.isFiltering) return this.sortedGenres.slice(0, TOP_COUNT)
      const query = this.debouncedQuery.trim().toLowerCase()
      return this.libraryStore.genres.filter((genre) => genre.name.toLowerCase().includes(query))
    },
    // Tile size reflects rank, not just decoration: #1 gets the spotlight
    // tile, #2–5 are featured-width, the rest are standard. Only meaningful
    // for the ranked top-20 view — search results are inherently unranked
    // (could be a single unpopular match), so they all render as standard.
    tieredGenres(): { genre: Genre; tier: Tier }[] {
      return this.filteredGenres.map((genre, index) => ({
        genre,
        tier: this.isFiltering ? 'standard' : index === 0 ? 'spotlight' : index < 5 ? 'featured' : 'standard',
      }))
    },
  },
  watch: {
    filterQuery(value: string | null) {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
      }, 200)
    },
  },
  created() {
    this.libraryStore.fetchGenres()
  },
}
</script>

<style scoped>
/* A ranked mosaic, not an A-Z index — dense auto-flow lets the spotlight
 * (2x2) and featured (2x1) tiles sit alongside standard ones with no gaps,
 * regardless of exactly how many of each tier there are. */
.genre-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  grid-auto-rows: 108px;
  grid-auto-flow: dense;
  gap: 12px;
}

.genre-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 16px;
  overflow: hidden;
  border-radius: 12px;
  background: rgb(var(--v-theme-surface));
  color: inherit;
  text-decoration: none;
  transition:
    transform 0.15s ease,
    background 0.15s ease;
}

.genre-tile:hover {
  transform: translateY(-2px);
  background: var(--beacon-hover);
}

.genre-tile:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.genre-tile__name {
  overflow: hidden;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.25;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.genre-tile__meta {
  margin-top: 4px;
  overflow: hidden;
  color: rgba(255, 255, 255, 0.55);
  font-size: 0.75rem;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* The #1 genre gets the same "beacon light" language as the nav rail's
 * active indicator — a warm glow picking one thing out, not a random
 * per-genre color. */
.genre-tile--spotlight {
  grid-row: span 2;
  grid-column: span 2;
  padding: 24px;
  background: radial-gradient(circle at 28% 24%, rgba(245, 169, 78, 0.3), rgba(26, 29, 39, 0.92) 68%);
  box-shadow:
    0 0 0 1px var(--beacon-hairline),
    0 20px 40px rgba(0, 0, 0, 0.35);
}

.genre-tile--spotlight:hover {
  background: radial-gradient(circle at 28% 24%, rgba(245, 169, 78, 0.4), rgba(26, 29, 39, 0.92) 68%);
}

.genre-tile--spotlight .genre-tile__name {
  white-space: normal;
  font-size: 2rem;
  font-weight: 700;
  line-height: 1.1;
}

.genre-tile--spotlight .genre-tile__meta {
  color: rgba(255, 255, 255, 0.7);
  font-size: 0.8125rem;
}

.genre-tile--featured {
  grid-column: span 2;
}

.genre-tile--featured .genre-tile__name {
  font-size: 1.25rem;
}

@media (prefers-reduced-motion: reduce) {
  .genre-tile {
    transition: none;
  }

  .genre-tile:hover {
    transform: none;
  }
}
</style>
