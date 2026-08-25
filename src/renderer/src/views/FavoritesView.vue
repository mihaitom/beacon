<template>
  <v-container fluid>
    <h1 class="page-title mb-4">{{ $t('favorites.title') }}</h1>

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
      <h2 class="section-title mb-2">{{ $t('favorites.songs') }}</h2>
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

type CardSection = 'artists' | 'albums'

// Remembered across visits, like NowPlayingView.vue's own visualizer
// preference — a layout choice that resets every time you navigate back
// here is worse than not offering it. One key per section, since the two
// are switched independently. Shelf is the default, so a missing (or
// unreadable) value means shelf.
const GRID_VIEW_KEY: Record<CardSection, string> = {
  artists: 'beacon.favoritesGridView.artists',
  albums: 'beacon.favoritesGridView.albums',
}

function readGridView(section: CardSection): boolean {
  try {
    return localStorage.getItem(GRID_VIEW_KEY[section]) === 'true'
  } catch {
    return false
  }
}

export default {
  name: 'FavoritesView',
  components: { AlbumCard, ArtistCard, CardShelf, SongTable },
  data() {
    return {
      gridView: { artists: readGridView('artists'), albums: readGridView('albums') },
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
      try {
        localStorage.setItem(GRID_VIEW_KEY[section], String(value))
      } catch {
        // Private mode/blocked storage — the toggle still works for this
        // visit, it just won't be remembered.
      }
    },
  },
}
</script>
