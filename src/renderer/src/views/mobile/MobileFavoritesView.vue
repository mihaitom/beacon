<template>
  <v-container fluid>
    <div class="mobile-header">
      <h1 class="page-title mobile-header__title">{{ $t('favorites.title') }}</h1>
    </div>

    <!-- Songs and albums only: the desktop page's artist shelf has nowhere
     - to lead on a phone, which has no artist page (see the router's note
     - on m-album-detail). -->
    <segmented-control
      :model-value="view"
      :options="viewOptions"
      :label="$t('favorites.title')"
      class="mobile-favorites__toggle"
      @update:model-value="view = $event as 'albums' | 'songs'"
    />

    <v-progress-circular v-if="libraryStore.loading" indeterminate class="view-notice" />

    <div class="mobile-favorites__list">
      <v-virtual-scroll
        v-if="showingSongs"
        renderless
        :items="starred.songs"
        :item-height="MOBILE_ROW_HEIGHT"
      >
        <template #default="{ item: song, index }">
          <mobile-song-row
            :key="song.id"
            :song="song"
            @play="play(index)"
            @open-actions="openActions(song)"
          />
        </template>
      </v-virtual-scroll>
      <v-virtual-scroll v-else renderless :items="starred.albums" :item-height="MOBILE_ROW_HEIGHT">
        <template #default="{ item: album }">
          <mobile-album-row :key="album.id" :album="album" @play="playAlbum(album)" />
        </template>
      </v-virtual-scroll>
    </div>

    <v-alert v-if="showEmptyState" type="info" variant="tonal">{{ emptyMessage }}</v-alert>

    <mobile-song-action-sheet v-model="actionsOpen" :song="activeSong" />
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import MobileSongRow from '@/components/mobile/MobileSongRow.vue'
import MobileAlbumRow from '@/components/mobile/MobileAlbumRow.vue'
import MobileSongActionSheet from '@/components/mobile/MobileSongActionSheet.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import { MOBILE_ROW_HEIGHT } from '@/components/mobile/rowMetrics'
import type { Album, Song } from '@/types/library'

export default {
  name: 'MobileFavoritesView',
  components: { MobileSongRow, MobileAlbumRow, MobileSongActionSheet, SegmentedControl },
  data() {
    return {
      MOBILE_ROW_HEIGHT,
      view: 'songs' as 'songs' | 'albums',
      actionsOpen: false,
      activeSong: null as Song | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    starred() {
      return this.libraryStore.starred
    },
    showingSongs(): boolean {
      return this.view === 'songs'
    },
    viewOptions() {
      return [
        { title: this.$t('favorites.songs'), value: 'songs' },
        { title: this.$t('favorites.albums'), value: 'albums' },
      ]
    },
    showEmptyState(): boolean {
      if (this.libraryStore.loading) return false
      return (this.showingSongs ? this.starred.songs : this.starred.albums).length === 0
    },
    emptyMessage(): string {
      return this.showingSongs ? this.$t('favorites.noSongsYet') : this.$t('favorites.noAlbumsYet')
    },
  },
  created() {
    this.libraryStore.fetchStarred()
  },
  methods: {
    /** The rest of the list plays on after the tapped song, unlike the
     * library's: favourites are a collection somebody put together, the
     * same reading the desktop page gives them (SongTable.vue's default
     * `queueWholeList`). */
    async play(index: number) {
      const songs = this.starred.songs
      await usePlaybackStore().playSongList(songs, index, true, songs.length > 1)
    },
    /** See MobileLibraryView's playAlbum(). */
    async playAlbum(album: Album) {
      const full = await this.libraryStore.fetchAlbum(album.id)
      await usePlaybackStore().playSongList(full.songs, 0, false, true)
    },
    openActions(song: Song) {
      this.activeSong = song
      this.actionsOpen = true
    },
  },
}
</script>

<style scoped>
.mobile-favorites__toggle {
  margin-bottom: 12px;
}

.mobile-favorites__list {
  display: flex;
  flex-direction: column;
}
</style>
