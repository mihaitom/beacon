<template>
  <v-container fluid>
    <h1 v-if="query" class="page-title mb-4">{{ $t('search.resultsFor', { query }) }}</h1>

    <template v-if="libraryStore.searchResults.artists.length">
      <h2 class="section-title mb-2">{{ $t('search.artists') }}</h2>
      <v-list class="beacon-list mb-4">
        <v-list-item
          v-for="artist in libraryStore.searchResults.artists"
          :key="artist.id"
          :to="`/artists/${artist.id}`"
          :title="artist.name"
        >
          <template #prepend>
            <cover-art :cover-art-id="artist.coverArtId" :size="40" rounded class="mr-3" />
          </template>
        </v-list-item>
      </v-list>
    </template>

    <template v-if="libraryStore.searchResults.albums.length">
      <h2 class="section-title mb-2">{{ $t('search.albums') }}</h2>
      <div class="album-grid mb-4">
        <album-card
          v-for="album in libraryStore.searchResults.albums"
          :key="album.id"
          :album="album"
        />
      </div>
    </template>

    <template v-if="libraryStore.searchResults.tracks.length">
      <h2 class="section-title mb-2">{{ $t('search.tracks') }}</h2>
      <track-list
        :tracks="libraryStore.searchResults.tracks"
        show-cover
        show-album
        show-genre
        show-year
        show-play-count
        show-format
      />
    </template>

    <v-progress-circular v-if="libraryStore.loading" indeterminate />
    <v-alert v-else-if="query && !hasResults" type="info" variant="tonal">
      {{ $t('search.noResults', { query }) }}
    </v-alert>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import CoverArt from '@/components/library/CoverArt.vue'
import AlbumCard from '@/components/library/AlbumCard.vue'
import TrackList from '@/components/library/TrackList.vue'

export default {
  name: 'SearchView',
  components: { CoverArt, AlbumCard, TrackList },
  data() {
    return {
      query: '',
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    hasResults() {
      const r = this.libraryStore.searchResults
      return r.artists.length > 0 || r.albums.length > 0 || r.tracks.length > 0
    },
  },
  created() {
    this.syncFromRoute()
  },
  watch: {
    // This view has no search field of its own anymore — TopBarSearch.vue
    // (the app bar's search icon) is the only entry point, and it always
    // arrives here via a route navigation (?q=...). A *new* search
    // submitted while already on this page still lands on the exact same
    // route component (same path, only the query differs), which Vue
    // Router reuses rather than remounting — so created() alone (the
    // previous approach, before the field's live-typing v-model drove
    // search() directly) would only ever pick up the very first query,
    // silently doing nothing for every search after that.
    '$route.query.q': 'syncFromRoute',
  },
  methods: {
    syncFromRoute() {
      if (typeof this.$route.query.q !== 'string') return
      this.query = this.$route.query.q
      this.libraryStore.search(this.query)
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
