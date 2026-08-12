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

    <div v-if="libraryStore.loading" class="album-grid">
      <div v-for="n in skeletonCount" :key="n" class="album-card">
        <v-skeleton-loader type="image" width="160" height="160" class="rounded album-card-cover" />
        <v-skeleton-loader type="text" width="70%" height="20" class="mt-2" />
        <v-skeleton-loader type="text" width="45%" height="16" />
      </div>
    </div>
    <div v-else class="album-grid">
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
// Fills a few full rows of the 160px card grid on a typical window width —
// there's no real count to key off yet (unlike TrackList's skeleton, which
// caps at however many rows are actually about to load), so just enough to
// read as "a grid is coming" without looking sparse.
const SKELETON_COUNT = 18

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
    skeletonCount() {
      return SKELETON_COUNT
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

.album-card {
  width: 160px;
}

/* v-skeleton-loader's width/height props only size the outer wrapper, not
 * the bone itself (see the identical comment/technique in TrackList.vue) —
 * forcing the bone to fill that wrapper is what makes each skeleton card
 * match AlbumCard.vue's real 160x160 cover + two text lines exactly, so
 * nothing shifts once real cards render in. */
.album-card :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}
</style>
