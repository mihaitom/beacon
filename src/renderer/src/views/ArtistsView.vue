<template>
  <v-container fluid>
    <detail-header
      fallback-icon="mdi-account-music"
      :eyebrow="$t('library.artist')"
      :title="$t('library.artists')"
    >
      <template v-if="filteredArtists.length" #meta>
        {{ filteredArtists.length }}
        {{ filteredArtists.length === 1 ? $t('library.artist') : $t('library.artists') }}
      </template>
    </detail-header>

    <sticky-filter>
      <v-text-field
        v-model="filterQuery"
        :label="$t('common.filter')"
        prepend-inner-icon="mdi-filter-variant"
        variant="solo-filled"
        density="compact"
        clearable
        class="mb-4"
        style="max-width: 320px"
      />
    </sticky-filter>
    <v-alert v-if="libraryStore.error" type="error" variant="tonal" class="mb-4">
      {{ libraryStore.error }}
    </v-alert>
    <v-progress-circular v-if="libraryStore.loading" indeterminate class="mb-4" />

    <div class="artist-grid">
      <artist-card v-for="artist in visibleArtists" :key="artist.id" :artist="artist" />
    </div>

    <v-alert
      v-if="!libraryStore.loading && filteredArtists.length === 0 && !libraryStore.error"
      type="info"
      variant="tonal"
    >
      {{
        filterQuery
          ? $t('library.noArtistsForQuery', { query: filterQuery })
          : $t('library.noArtistsFound')
      }}
    </v-alert>

    <infinite-scroll-trigger
      v-if="visibleCount < filteredArtists.length"
      @trigger="loadMore"
    />
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import DetailHeader from '@/components/library/DetailHeader.vue'
import ArtistCard from '@/components/library/ArtistCard.vue'
import InfiniteScrollTrigger from '@/components/InfiniteScrollTrigger.vue'
import StickyFilter from '@/components/StickyFilter.vue'

const PAGE_SIZE = 60

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'ArtistsView',
  components: { DetailHeader, ArtistCard, InfiniteScrollTrigger, StickyFilter },
  data() {
    return {
      // getArtists.view has no server-side pagination — it returns the whole
      // library's artist index in one call (verified: 6000+ artists, ~3s to
      // render unbounded). Fetch once, but only ever render a growing slice,
      // same "Mehr laden" pattern as AlbumsView. The filter below runs
      // client-side over everything already loaded, so it's a full-library
      // search despite the paginated rendering.
      visibleCount: PAGE_SIZE,
      filterQuery: '',
      // filteredArtists reads this instead of filterQuery directly — a
      // full-library scan on every keystroke would block the same render
      // pass that's supposed to show the character just typed, making the
      // input itself feel laggy. filterQuery still updates instantly (it's
      // just the input's own text); only the actual filtering waits a beat.
      debouncedQuery: '',
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    filteredArtists() {
      const query = this.debouncedQuery.trim().toLowerCase()
      if (!query) return this.libraryStore.artists
      return this.libraryStore.artists.filter((artist: { name: string }) =>
        artist.name.toLowerCase().includes(query),
      )
    },
    visibleArtists() {
      return this.filteredArtists.slice(0, this.visibleCount)
    },
  },
  watch: {
    filterQuery(value: string | null) {
      this.visibleCount = PAGE_SIZE
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
      }, 200)
    },
  },
  created() {
    this.libraryStore.fetchArtists()
  },
  methods: {
    loadMore() {
      this.visibleCount += PAGE_SIZE
    },
  },
}
</script>

<style scoped>
.artist-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
}
</style>
