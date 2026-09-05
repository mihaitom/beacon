<template>
  <v-container fluid>
    <h1 v-if="query" class="page-title">{{ $t('search.resultsFor', { query }) }}</h1>

    <!-- Shelves, the same shape Home and the favorites page use, rather
     - than a list and a wrapping grid. A search for a common word can
     - match dozens of each, and stacked downwards they pushed the matching
     - songs off the screen entirely; sideways each kind of match takes one
     - row's worth of height however many there are.
     -
     - Each shelf carries its own grid toggle, switched and remembered
     - separately: someone whose search turned up three artists and ninety
     - albums wants those two laid out differently. -->
    <card-shelf
      v-if="libraryStore.searchResults.artists.length"
      :title="$t('search.artists')"
      :wrap="gridView.artists"
      wrap-toggle
      @update:wrap="setGridView('artists', $event)"
    >
      <artist-card
        v-for="artist in libraryStore.searchResults.artists"
        :key="artist.id"
        :artist="artist"
      />
    </card-shelf>

    <card-shelf
      v-if="libraryStore.searchResults.albums.length"
      :title="$t('search.albums')"
      :wrap="gridView.albums"
      wrap-toggle
      @update:wrap="setGridView('albums', $event)"
    >
      <album-card
        v-for="album in libraryStore.searchResults.albums"
        :key="album.id"
        :album="album"
      />
    </card-shelf>

    <template v-if="libraryStore.searchResults.songs.length">
      <h2 class="section-title">{{ $t('search.songs') }}</h2>
      <!-- One song, not the whole result set: a search result is a list of
         - things that merely match a word, not a sequence anyone meant to
         - listen to in order. Playing "Moon" and getting nineteen other
         - songs with "moon" in the title queued behind it is not what the
         - click asked for. The row's own menu still offers Play next, Add
         - to queue and Song Radio for building a queue on purpose. -->
      <song-table
        :songs="libraryStore.searchResults.songs"
        :queue-whole-list="false"
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
import AlbumCard from '@/components/library/AlbumCard.vue'
import ArtistCard from '@/components/library/ArtistCard.vue'
import CardShelf from '@/components/library/CardShelf.vue'
import SongTable from '@/components/library/SongTable.vue'
import { readCardGridView, writeCardGridView } from '@/services/cardGridView'

type CardSection = 'artists' | 'albums'

// Kept apart from the favorites page's own keys: the same person can want
// their favorite artists as a grid and their search matches as a shelf.
const GRID_VIEW_KEY: Record<CardSection, string> = {
  artists: 'beacon.searchGridView.artists',
  albums: 'beacon.searchGridView.albums',
}

export default {
  name: 'SearchView',
  components: { AlbumCard, ArtistCard, CardShelf, SongTable },
  data() {
    return {
      query: '',
      gridView: {
        artists: readCardGridView(GRID_VIEW_KEY.artists),
        albums: readCardGridView(GRID_VIEW_KEY.albums),
      },
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    hasResults() {
      const r = this.libraryStore.searchResults
      return r.artists.length > 0 || r.albums.length > 0 || r.songs.length > 0
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
    setGridView(section: CardSection, value: boolean) {
      this.gridView[section] = value
      writeCardGridView(GRID_VIEW_KEY[section], value)
    },
    syncFromRoute() {
      if (typeof this.$route.query.q !== 'string') return
      this.query = this.$route.query.q
      this.libraryStore.search(this.query)
    },
  },
}
</script>

<style scoped>
/* One rhythm for the page: the query heading, then a heading and its
 * results per kind of match. */
.page-title {
  margin-bottom: 16px;
}

.section-title {
  margin-bottom: 8px;
}

.search-group {
  margin-bottom: 16px;
}

.search-result__art {
  margin-right: 12px;
}
</style>
