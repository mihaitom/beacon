<template>
  <v-container fluid>
    <h1 v-if="query" class="page-title">{{ $t('search.resultsFor', { query }) }}</h1>

    <!-- In place of the results rather than under the previous ones: a
       - spinner below a page of stale matches read as more of them loading. -->
    <page-loader v-if="libraryStore.loading" :label="$t('search.searching')" />
    <template v-else>
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

      <search-songs-section
        v-if="libraryStore.searchResults.songs.length"
        :title="$t('search.songs')"
        :songs="libraryStore.searchResults.songs"
        :foldable="sonicShowing.sound || sonicShowing.lyrics"
      />

      <sonic-search-section kind="sound" :query="query" @showing="sonicShowing.sound = $event" />
      <sonic-search-section kind="lyrics" :query="query" @showing="sonicShowing.lyrics = $event" />

      <empty-state
        v-if="query && !hasResults && !sonicShowing.sound && !sonicShowing.lyrics"
        icon="mdi-magnify-close"
        :title="$t('search.noResults', { query })"
        :text="$t('search.noResultsHint')"
      />
    </template>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import EmptyState from '@/components/EmptyState.vue'
import PageLoader from '@/components/PageLoader.vue'
import AlbumCard from '@/components/library/AlbumCard.vue'
import ArtistCard from '@/components/library/ArtistCard.vue'
import CardShelf from '@/components/library/CardShelf.vue'
import SearchSongsSection from '@/components/library/SearchSongsSection.vue'
import SonicSearchSection from '@/components/library/SonicSearchSection.vue'
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
  components: {
    EmptyState,
    PageLoader,
    AlbumCard,
    ArtistCard,
    CardShelf,
    SearchSongsSection,
    SonicSearchSection,
  },
  data() {
    return {
      query: '',
      // Whether AudioMuse's sections below have anything to show, so the
      // empty state does not claim "nothing found" above their results.
      sonicShowing: { sound: false, lyrics: false },
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
    // The exact-spelling toggle sits in the top bar's field (and every
    // library filter's), which only store the choice; the results on screen
    // have to be asked for again with it.
    'libraryStore.searchExact'() {
      if (this.query) this.libraryStore.search(this.query)
    },
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
 * results per kind of match (each section spaces its own heading). */
.page-title {
  margin-bottom: 16px;
}
</style>
