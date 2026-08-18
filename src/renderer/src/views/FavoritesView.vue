<template>
  <v-container fluid>
    <h1 class="page-title mb-4">{{ $t('favorites.title') }}</h1>

    <template v-if="libraryStore.starred.albums.length">
      <h2 class="section-title mb-2">{{ $t('favorites.albums') }}</h2>
      <div class="album-grid mb-4">
        <album-card v-for="album in libraryStore.starred.albums" :key="album.id" :album="album" />
      </div>
    </template>

    <template v-if="libraryStore.starred.songs.length">
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
import SongTable from '@/components/library/SongTable.vue'

export default {
  name: 'FavoritesView',
  components: { AlbumCard, SongTable },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
  },
  created() {
    this.libraryStore.fetchStarred()
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
