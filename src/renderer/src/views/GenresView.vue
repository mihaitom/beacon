<template>
  <v-container fluid>
    <!-- The same header as the other overviews (Albums, Artists, Songs),
     - without their play buttons: this page is where a genre gets picked,
     - and playing one belongs to that genre's own page. -->
    <detail-header :title="$t('library.genres')" stored-fanart>
      <template v-if="libraryStore.genres.length" #meta>
        {{ $n(libraryStore.genres.length) }}
        {{ libraryStore.genres.length === 1 ? $t('library.genre') : $t('library.genres') }}
      </template>
    </detail-header>

    <sticky-filter>
      <div class="library-filter">
        <v-text-field
          v-model="filterQuery"
          :placeholder="$t('search.label')"
          :aria-label="$t('search.label')"
          prepend-inner-icon="mdi-magnify"
          variant="solo-filled"
          density="compact"
          rounded="pill"
          flat
          clearable
          hide-details
          class="library-search"
        >
          <template #append-inner><exact-match-switch /></template>
        </v-text-field>
      </div>
    </sticky-filter>
    <v-alert v-if="libraryStore.error" type="error" variant="tonal" class="view-notice">
      {{ libraryStore.error }}
    </v-alert>
    <!-- Only until the genres are in: the album covers below load after
     - them, under the same loading flag, and must not hold the page. -->
    <v-progress-circular
      v-if="libraryStore.loading && !libraryStore.genres.length"
      indeterminate
      class="view-notice"
    />
    <template v-else-if="indexGroups.length">
      <!-- The biggest genres as crates of records; while searching only the
       - register below, which lists every match. -->
      <section v-if="!isFiltering && crates.length" class="genre-crates-section">
        <h2 class="section-title">{{ $t('library.genresBiggest') }}</h2>
        <div class="genre-crates">
          <genre-crate
            v-for="genre in crates"
            :key="genre.name"
            :genre="genre"
            :covers="coversFor(genre)"
          />
        </div>
      </section>

      <section class="genre-register" :class="{ 'genre-register--with-bar': !isFiltering }">
        <h2 v-if="!isFiltering" class="section-title">{{ $t('library.genresAll') }}</h2>
        <!-- A book's index: columns read top to bottom, each genre led by
         - dots to its number of songs. How strongly a name is set follows
         - how much of the library it holds, so the few that matter stand
         - out of the long tail of one-song genres. -->
        <div class="genre-register__columns">
          <section
            v-for="group in indexGroups"
            :id="`genre-letter-${group.letter}`"
            :key="group.letter"
            class="genre-register__group"
            :data-genre-index="group.firstIndex"
          >
            <h3 class="genre-register__letter">{{ group.letter }}</h3>
            <ul class="genre-register__entries">
              <li v-for="genre in group.genres" :key="genre.name">
                <router-link
                  :to="`/genres/${encodeURIComponent(genre.name)}`"
                  class="genre-register__entry"
                  :class="`genre-register__entry--${weightOf(genre)}`"
                >
                  <span class="genre-register__name">{{ genre.name }}</span>
                  <span class="genre-register__leader" aria-hidden="true" />
                  <span class="genre-register__count">{{ $n(genre.songCount) }}</span>
                </router-link>
              </li>
            </ul>
          </section>
        </div>
      </section>

      <alphabet-index-bar
        v-if="!isFiltering"
        :available="availableLetters"
        :active="activeLetter"
        @select="jumpToLetter"
      />
    </template>
    <empty-state
      v-else-if="!libraryStore.loading || libraryStore.genres.length"
      :icon="filterQuery ? 'mdi-magnify-close' : 'mdi-tag-off-outline'"
      :title="
        filterQuery
          ? $t('library.noGenresForQuery', { query: filterQuery })
          : $t('library.noGenresFound')
      "
    />
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import EmptyState from '@/components/EmptyState.vue'
import { matchesAllTerms } from '@/services/textSearch'
import StickyFilter from '@/components/StickyFilter.vue'
import DetailHeader from '@/components/library/DetailHeader.vue'
import ExactMatchSwitch from '@/components/library/ExactMatchSwitch.vue'
import GenreCrate from '@/components/library/GenreCrate.vue'
import AlphabetIndexBar from '@/components/library/AlphabetIndexBar.vue'
import { coversByGenre } from '@/services/genreCovers'
import { STACK_COVERS } from '@/services/library/stackCovers'
import { letterForName } from '@/services/alphabetIndex'
import { observeActiveLetter, type ActiveLetterHandle } from '@/services/activeLetter'
import type { Genre } from '@/types/library'

let debounceTimer: ReturnType<typeof setTimeout> | undefined

/** The biggest genres shown as crates: as many as fill their rows (see the
 * grid's styles), at most two rows of four or one of eight. */
const CRATE_COUNT = 8

interface IndexGroup {
  letter: string
  genres: Genre[]
  /** The group's first genre's position in the register, which the
   * alphabet bar's "you are here" reads (see observeActiveLetter). */
  firstIndex: number
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export default {
  name: 'GenresView',
  components: {
    EmptyState,
    DetailHeader,
    StickyFilter,
    ExactMatchSwitch,
    GenreCrate,
    AlphabetIndexBar,
  },
  data() {
    return {
      filterQuery: '',
      // filteredGenres reads this instead of filterQuery directly, so
      // filtering doesn't run synchronously on every keystroke — see the
      // identical pattern (and its rationale) in SongsView.vue.
      debouncedQuery: '',
      activeLetter: null as string | null,
      activeLetterObserver: null as ActiveLetterHandle | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    isFiltering(): boolean {
      return this.debouncedQuery.trim().length > 0
    },
    // Biggest first — songCount is the only popularity signal getGenres.view
    // gives us.
    crates(): Genre[] {
      return [...this.libraryStore.genres]
        .sort((a, b) => b.songCount - a.songCount)
        .slice(0, CRATE_COUNT)
    },
    // Every genre, or every match while searching - the crates above are a
    // way in, not a cap on what can be found.
    registerGenres(): Genre[] {
      const genres = this.isFiltering
        ? this.libraryStore.genres.filter((genre) =>
            matchesAllTerms(this.debouncedQuery, [genre.name], {
              exact: this.libraryStore.searchExact,
            }),
          )
        : this.libraryStore.genres
      return [...genres].sort((a, b) => collator.compare(a.name, b.name))
    },
    indexGroups(): IndexGroup[] {
      const groups: IndexGroup[] = []
      this.registerGenres.forEach((genre, index) => {
        const letter = letterForName(genre.name)
        const last = groups[groups.length - 1]
        if (last?.letter === letter) last.genres.push(genre)
        else groups.push({ letter, genres: [genre], firstIndex: index })
      })
      return groups
    },
    letterFirstIndex(): Map<string, number> {
      return new Map(this.indexGroups.map((group) => [group.letter, group.firstIndex]))
    },
    availableLetters(): Set<string> {
      return new Set(this.letterFirstIndex.keys())
    },
    /** Song counts at which a register entry is set stronger: the top
     * tenth of the genres, and everything from the median up. */
    weightThresholds(): { strong: number; regular: number } {
      const counts = this.libraryStore.genres.map((g) => g.songCount).sort((a, b) => b - a)
      const at = (share: number) => counts[Math.floor((counts.length - 1) * share)] ?? 0
      return { strong: Math.max(2, at(0.1)), regular: Math.max(2, at(0.5)) }
    },
    coverMap(): Map<string, string[]> {
      return coversByGenre(this.libraryStore.albums, STACK_COVERS)
    },
  },
  watch: {
    filterQuery(value: string | null) {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
      }, 200)
    },
    indexGroups() {
      this.$nextTick(() => this.activeLetterObserver?.update())
    },
  },
  async created() {
    await this.libraryStore.fetchGenres()
    // The crates' covers come from the album list, which the albums page
    // keeps cached anyway. After the genres, so the names show first.
    void this.libraryStore.fetchAlbums()
  },
  mounted() {
    this.activeLetterObserver = observeActiveLetter({
      itemSelector: '[data-genre-index]',
      readIndex: (item) => {
        const value = item.getAttribute('data-genre-index')
        return value === null ? null : Number(value)
      },
      letterFirstIndex: () => this.letterFirstIndex,
      onChange: (letter) => {
        this.activeLetter = letter
      },
    })
  },
  beforeUnmount() {
    this.activeLetterObserver?.stop()
  },
  methods: {
    weightOf(genre: Genre): 'strong' | 'regular' | 'faint' {
      if (genre.songCount >= this.weightThresholds.strong) return 'strong'
      if (genre.songCount >= this.weightThresholds.regular) return 'regular'
      return 'faint'
    },
    coversFor(genre: Genre): string[] {
      return this.coverMap.get(genre.name.toLowerCase()) ?? []
    },
    jumpToLetter(letter: string) {
      this.activeLetter = letter
      document
        .getElementById(`genre-letter-${letter}`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    },
  },
}
</script>

<style scoped>
.genre-crates-section {
  margin-bottom: 40px;
  /* Clear of AlphabetIndexBar, like the register below. */
  margin-right: 40px;
}

.genre-crates-section .section-title,
.genre-register .section-title {
  margin-bottom: 16px;
}

/* A crate needs about 350px for a long one-word name ("Contemporary")
 * beside its records; narrower, the name broke mid-word. So the columns
 * step at multiples of CRATE_MIN, and the crates shown always fill their
 * rows: two rows up to four across, one row from five on - eight crates
 * three across would leave two alone in a third row. Measured on the
 * section, which an open queue narrows. */
.genre-crates-section {
  container-type: inline-size;
}

.genre-crates {
  /* CRATE_MIN: 360px, the 350px above with room for another platform's
   * font rendering. Each step below is n * 360 + (n - 1) * 16. */
  --crate-columns: 1;
  display: grid;
  grid-template-columns: repeat(var(--crate-columns), minmax(0, 1fr));
  gap: 16px;
}

@container (width >= 736px) {
  .genre-crates {
    --crate-columns: 2;
  }
}

@container (1112px <= width < 1456px) {
  .genre-crates {
    --crate-columns: 3;
  }
  .genre-crates > :nth-child(n + 7) {
    display: none;
  }
}

@container (width >= 1456px) {
  .genre-crates {
    --crate-columns: 4;
  }
}

@container (1864px <= width < 2240px) {
  .genre-crates {
    --crate-columns: 5;
  }
  .genre-crates > :nth-child(n + 6) {
    display: none;
  }
}

@container (2240px <= width < 2616px) {
  .genre-crates {
    --crate-columns: 6;
  }
  .genre-crates > :nth-child(n + 7) {
    display: none;
  }
}

@container (2616px <= width < 2992px) {
  .genre-crates {
    --crate-columns: 7;
  }
  .genre-crates > :nth-child(n + 8) {
    display: none;
  }
}

@container (width >= 2992px) {
  .genre-crates {
    --crate-columns: 8;
  }
}

/* Clear of AlphabetIndexBar, as the grids on Albums and Artists are. */
.genre-register--with-bar {
  margin-right: 40px;
}

/* Book-index columns: as many ~260px columns as fit, a letter's
 * group never split across two. */
.genre-register__columns {
  columns: 260px;
  column-gap: 48px;
}

.genre-register__group {
  break-inside: avoid;
  margin-bottom: 28px;
  /* Lands a jumped-to letter below the app bar and the sticky filter. */
  scroll-margin-top: 140px;
}

.genre-register__letter {
  margin: 0 0 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--beacon-hairline);
  font-size: 1.6rem;
  font-weight: 700;
  line-height: 1;
  color: rgba(var(--v-theme-on-surface), 0.9);
}

.genre-register__entries {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Name, dots, number: the dots take whatever width is left, so every
 * number lines up at the column's right edge. */
.genre-register__entry {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 0;
  color: rgba(var(--v-theme-on-surface), 0.78);
  text-decoration: none;
  font-size: 0.92rem;
  line-height: 1.45;
}

.genre-register__name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.genre-register__leader {
  flex: 1 1 auto;
  min-width: 12px;
  border-bottom: 1px dotted rgba(var(--v-theme-on-surface), 0.18);
  transform: translateY(-4px);
}

.genre-register__count {
  flex-shrink: 0;
  font-size: 0.78rem;
  color: rgba(var(--v-theme-on-surface), 0.45);
  font-variant-numeric: tabular-nums;
}

.genre-register__entry--strong {
  color: rgb(var(--v-theme-on-surface));
  font-weight: 600;
}

.genre-register__entry--strong .genre-register__count {
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.genre-register__entry--faint {
  color: rgba(var(--v-theme-on-surface), 0.5);
}

.genre-register__entry:hover,
.genre-register__entry:hover .genre-register__count {
  color: rgb(var(--v-theme-primary));
}

.genre-register__entry:hover .genre-register__leader {
  border-bottom-color: rgba(var(--v-theme-primary), 0.5);
}

.genre-register__entry:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
  border-radius: 4px;
}
</style>
