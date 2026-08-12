<template>
  <v-container fluid>
    <detail-header :eyebrow="$t('library.album')" :title="$t('library.albums')">
      <template v-if="filteredAlbums.length" #meta>
        {{ filteredAlbums.length }}
        {{ filteredAlbums.length === 1 ? $t('library.album1') : $t('library.albumsN') }}
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

    <div class="album-grid">
      <album-card v-for="album in visibleAlbums" :key="album.id" :album="album" />
    </div>

    <v-alert
      v-if="!libraryStore.loading && filteredAlbums.length === 0 && !libraryStore.error"
      type="info"
      variant="tonal"
    >
      {{
        filterQuery
          ? $t('library.noAlbumsForQuery', { query: filterQuery })
          : $t('library.noAlbumsFound')
      }}
    </v-alert>

    <infinite-scroll-trigger v-if="visibleCount < filteredAlbums.length" @trigger="loadMore" />
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import DetailHeader from '@/components/library/DetailHeader.vue'
import AlbumCard from '@/components/library/AlbumCard.vue'
import InfiniteScrollTrigger from '@/components/InfiniteScrollTrigger.vue'
import StickyFilter from '@/components/StickyFilter.vue'

const PAGE_SIZE = 60

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'AlbumsView',
  components: { DetailHeader, AlbumCard, InfiniteScrollTrigger, StickyFilter },
  data() {
    return {
      // fetchAlbums() loads the whole catalog in one (cached) go — same
      // "load once, render a growing slice" pattern as ArtistsView. The
      // filter below runs client-side over everything already loaded.
      visibleCount: PAGE_SIZE,
      filterQuery: '',
      // filteredAlbums reads this instead of filterQuery directly — see
      // ArtistsView's identical debounce for why (avoids the freshly-typed
      // character sharing a render pass with a full-list re-filter).
      debouncedQuery: '',
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    filteredAlbums() {
      const query = this.debouncedQuery.trim().toLowerCase()
      if (!query) return this.libraryStore.albums
      return this.libraryStore.albums.filter((album) => album.name.toLowerCase().includes(query))
    },
    visibleAlbums() {
      return this.filteredAlbums.slice(0, this.visibleCount)
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
    this.libraryStore.fetchAlbums()
  },
  methods: {
    loadMore() {
      this.visibleCount += PAGE_SIZE
    },
  },
}
</script>

<style scoped>
.album-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
</style>
