<template>
  <v-container v-if="album" fluid>
    <div class="mobile-header">
      <cover-art
        :cover-art-id="album.coverArtId"
        :size="72"
        fallback-icon="mdi-album"
        class="mobile-album-detail__cover"
      />
      <div class="mobile-header__title">
        <h1 class="page-title">{{ album.name }}</h1>
        <!-- The artist as text, not a link: there is no artist page in this
         - shell to send the tap to (see NowPlayingView.vue's own compact
         - branch for the same decision). -->
        <div class="text-body-small text-medium-emphasis">{{ album.artist }}</div>
        <div class="text-body-small text-medium-emphasis">{{ meta }}</div>
      </div>
      <v-btn
        icon="mdi-play-circle"
        color="primary"
        size="large"
        variant="text"
        :disabled="!album.songs.length"
        @click="playAll"
      />
    </div>

    <div class="mobile-album-detail__list">
      <mobile-song-row
        v-for="(song, index) in album.songs"
        :key="song.id"
        :song="song"
        @play="play(index)"
        @open-actions="openActions(song)"
      />
    </div>

    <mobile-song-action-sheet v-model="actionsOpen" :song="activeSong" />
  </v-container>
  <v-container v-else>
    <div v-if="libraryStore.loading" class="mobile-album-detail__loading">
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
import type { Album, Song } from '@/types/library'

export default {
  name: 'MobileAlbumDetailView',
  components: { CoverArt, MobileSongRow, MobileSongActionSheet },
  data() {
    return {
      album: null as Album | null,
      actionsOpen: false,
      activeSong: null as Song | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    meta(): string {
      const count = this.$t('library.songCount', { count: this.album?.songCount ?? 0 })
      return this.album?.year ? `${this.album.year} · ${count}` : count
    },
  },
  created() {
    this.loadAlbum()
  },
  watch: {
    '$route.params.id': 'loadAlbum',
  },
  methods: {
    async loadAlbum() {
      const id = this.$route.params.id as string
      try {
        const album = await this.libraryStore.fetchAlbum(id)
        if (this.$route.params.id === id) this.album = album
      } catch (error) {
        if (this.$route.params.id !== id) return
        console.error('[mobile-album-detail] Failed to load album:', error)
      }
    },
    async playAll() {
      if (!this.album?.songs.length) return
      // pinFirst: false - see MobileLibraryView.vue's playAlbum() for why an
      // album's own order is the one thing shuffle may not keep.
      await usePlaybackStore().playSongList(this.album.songs, 0, false, true)
    },
    async play(index: number) {
      if (!this.album) return
      // The rest of the album follows the tapped track, unlike the library
      // list where a tap queues that song alone: this one is a sequence
      // somebody meant. Same split the desktop SongTable.vue makes.
      await usePlaybackStore().playSongList(this.album.songs, index)
    },
    openActions(song: Song) {
      this.activeSong = song
      this.actionsOpen = true
    },
  },
}
</script>

<style scoped>
/* The spinner while the album loads, centered in the space its rows will
 * take. */
.mobile-album-detail__loading {
  display: flex;
  justify-content: center;
  padding: 24px;
}

/* The header row's own leading element - .mobile-header supplies the gap
 * between it and the text, so this only has to stay its own size. */
.mobile-album-detail__cover {
  flex-shrink: 0;
}

.mobile-album-detail__list {
  display: flex;
  flex-direction: column;
}

/* An album name can be long; the header stays one line. */
.mobile-header__title .page-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
