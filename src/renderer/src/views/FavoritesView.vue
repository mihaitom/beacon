<template>
  <v-container fluid>
    <h1 class="page-title">{{ $t('favorites.title') }}</h1>

    <!-- Scrolling rows by default, same shape as the Home view's shelves:
     - a large favorites collection otherwise pushed the songs table
     - entirely off-screen behind rows and rows of cards. Each shelf has its
     - own grid toggle in its header — someone with 200 favorite albums and
     - four favorite artists wants those two laid out differently. -->
    <card-shelf
      v-if="libraryStore.starred.artists.length"
      :title="$t('favorites.artists')"
      :wrap="gridView.artists"
      wrap-toggle
      @update:wrap="setGridView('artists', $event)"
    >
      <artist-card
        v-for="artist in libraryStore.starred.artists"
        :key="artist.id"
        :artist="artist"
      />
    </card-shelf>

    <card-shelf
      v-if="libraryStore.starred.albums.length"
      :title="$t('favorites.albums')"
      :wrap="gridView.albums"
      wrap-toggle
      @update:wrap="setGridView('albums', $event)"
    >
      <album-card v-for="album in libraryStore.starred.albums" :key="album.id" :album="album" />
    </card-shelf>

    <template v-if="libraryStore.starred.songs.length">
      <!-- Not a shelf: a table has its own vertical rhythm, and there is
       - nothing to page through sideways. -->
      <h2 class="section-title">{{ $t('favorites.songs') }}</h2>
      <song-table
        :songs="libraryStore.starred.songs"
        show-cover
        show-album
        show-genre
        show-year
        show-play-count
        show-format
      />
    </template>

    <v-alert
      v-if="
        !libraryStore.loading &&
        !libraryStore.starred.artists.length &&
        !libraryStore.starred.albums.length &&
        !libraryStore.starred.songs.length
      "
      type="info"
      variant="tonal"
    >
      {{ $t('favorites.noneYet') }}
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

// One key per section, since the two are switched independently. The
// reading and writing itself is services/cardGridView.ts, shared with the
// search results, which offer the same toggle.
const GRID_VIEW_KEY: Record<CardSection, string> = {
  artists: 'beacon.favoritesGridView.artists',
  albums: 'beacon.favoritesGridView.albums',
}

export default {
  name: 'FavoritesView',
  components: { AlbumCard, ArtistCard, CardShelf, SongTable },
  data() {
    return {
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
  },
  created() {
    this.libraryStore.fetchStarred()
  },
  methods: {
    setGridView(section: CardSection, value: boolean) {
      this.gridView[section] = value
      writeCardGridView(GRID_VIEW_KEY[section], value)
    },
  },
}
</script>

<style scoped>
.page-title {
  margin-bottom: 16px;
}

.section-title {
  margin-bottom: 8px;
}
</style>
