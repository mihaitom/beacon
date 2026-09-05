<template>
  <v-container v-if="playlist" fluid>
    <div class="mobile-header">
      <cover-art
        :cover-art-id="playlist.coverArtId"
        :size="72"
        fallback-icon="mdi-playlist-music"
        class="mobile-playlist-detail__cover"
      />
      <div class="mobile-header__title">
        <h1 class="page-title text-truncate">{{ playlist.name }}</h1>
        <div class="text-body-small text-medium-emphasis">
          {{ $t('playlists.songCount', { count: playlist.songCount }) }}
        </div>
      </div>
      <v-btn
        icon="mdi-play-circle"
        color="primary"
        size="large"
        variant="text"
        :disabled="!playlist.songs.length"
        @click="playAll"
      />
    </div>

    <div class="mobile-playlist-detail__list">
      <mobile-song-row
        v-for="(song, index) in playlist.songs"
        :key="song.id"
        :song="song"
        @play="play(index)"
        @open-actions="openActions(song)"
      />
    </div>

    <mobile-song-action-sheet v-model="actionsOpen" :song="activeSong" />
  </v-container>
  <v-container v-else>
    <div v-if="libraryStore.loading" class="d-flex justify-center pa-6">
      <v-progress-circular indeterminate color="primary" />
    </div>
    <v-alert v-else-if="libraryStore.error" type="error" variant="tonal">{{
      libraryStore.error
    }}</v-alert>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import CoverArt from '@/components/library/CoverArt.vue'
import MobileSongRow from '@/components/mobile/MobileSongRow.vue'
import MobileSongActionSheet from '@/components/mobile/MobileSongActionSheet.vue'
import type { Song } from '@/types/library'

export default {
  name: 'MobilePlaylistDetailView',
  components: { CoverArt, MobileSongRow, MobileSongActionSheet },
  data() {
    return {
      playlist: null as Awaited<
        ReturnType<ReturnType<typeof useLibraryStore>['fetchPlaylist']>
      > | null,
      actionsOpen: false,
      activeSong: null as Song | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
  },
  created() {
    this.loadPlaylist()
  },
  watch: {
    '$route.params.id': 'loadPlaylist',
  },
  methods: {
    async loadPlaylist() {
      const id = this.$route.params.id as string
      try {
        const playlist = await this.libraryStore.fetchPlaylist(id)
        if (this.$route.params.id === id) this.playlist = playlist
      } catch (error) {
        if (this.$route.params.id !== id) return
        console.error('[mobile-playlist-detail] Failed to load playlist:', error)
      }
    },
    async playAll() {
      if (!this.playlist?.songs.length) return
      // pinFirst: false — see desktop PlaylistDetailView.vue's identical comment.
      await usePlaybackStore().playSongList(this.playlist.songs, 0, false)
    },
    async play(index: number) {
      if (!this.playlist) return
      await usePlaybackStore().playSongList(this.playlist.songs, index)
    },
    openActions(song: Song) {
      this.activeSong = song
      this.actionsOpen = true
    },
  },
}
</script>

<style scoped>
/* The header row's own leading element — .mobile-header supplies the gap
 * between it and the text, so this only has to stay its own size. */
.mobile-playlist-detail__cover {
  flex-shrink: 0;
}

.mobile-playlist-detail__list {
  display: flex;
  flex-direction: column;
}

.min-width-0 {
  min-width: 0;
}
</style>
