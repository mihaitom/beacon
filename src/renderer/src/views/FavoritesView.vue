<template>
  <v-container fluid>
    <!-- Backgrounds from the favourites' own artists only, the way a genre
     - page shows its genre's - this page is the one that is about taste. -->
    <detail-header
      :eyebrow="$t('favorites.eyebrow')"
      :title="$t('favorites.title')"
      :stored-fanart="favoriteArtistNames"
    >
      <template v-if="summary" #meta>{{ summary }}</template>
    </detail-header>

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
      <song-table :songs="libraryStore.starred.songs" />
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
import DetailHeader from '@/components/library/DetailHeader.vue'
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
  components: { AlbumCard, ArtistCard, CardShelf, DetailHeader, SongTable },
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
    starred() {
      return this.libraryStore.starred
    },
    favoriteArtistNames(): string[] {
      const names = [
        ...this.starred.artists.map((artist) => artist.name),
        ...this.starred.albums.map((album) => album.artist),
        ...this.starred.songs.map((song) => song.artist),
      ]
      return [...new Set(names.filter(Boolean))].sort()
    },
    summary(): string {
      const counts: [string, number][] = [
        ['favorites.countArtists', this.starred.artists.length],
        ['favorites.countAlbums', this.starred.albums.length],
        ['favorites.countSongs', this.starred.songs.length],
      ]
      return counts
        .filter(([, n]) => n > 0)
        .map(([key, n]) => this.$t(key, n))
        .join(' · ')
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
.section-title {
  margin-bottom: 8px;
}
</style>
