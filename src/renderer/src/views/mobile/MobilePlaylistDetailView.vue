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
        <h1 class="page-title">{{ playlist.name }}</h1>
        <div class="text-body-small text-medium-emphasis">
          {{ $t('playlists.songCount', { count: playlist.songs.length }) }}
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

    <playlist-notice v-if="notice" :notice="notice" @undo="runUndo" @dismiss="notice = null" />

    <!-- See the desktop page's own note on when a playlist can be empty. -->
    <v-alert v-if="!playlist.songs.length" type="info" variant="tonal" class="view-notice">
      {{ $t('playlists.noSongsYet') }}
    </v-alert>
    <div v-else class="mobile-playlist-detail__list">
      <mobile-song-row
        v-for="(song, index) in playlist.songs"
        :key="`${song.id}-${index}`"
        :song="song"
        @play="play(index)"
        @open-actions="openActions(song, index)"
      />
    </div>

    <mobile-song-action-sheet
      v-model="actionsOpen"
      :song="activeSong"
      :removable="isOwnPlaylist"
      @remove="onRemove"
    />
  </v-container>
  <v-container v-else>
    <div v-if="libraryStore.loading" class="mobile-playlist-detail__loading">
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
import { useAuthStore } from '@/stores/auth'
import CoverArt from '@/components/library/CoverArt.vue'
import MobileSongRow from '@/components/mobile/MobileSongRow.vue'
import MobileSongActionSheet from '@/components/mobile/MobileSongActionSheet.vue'
import PlaylistNotice from '@/components/library/PlaylistNotice.vue'
import {
  removeFromPlaylist,
  type PlaylistNotice as Notice,
} from '@/services/library/playlistRemoval'
import type { Song } from '@/types/library'

export default {
  name: 'MobilePlaylistDetailView',
  components: { CoverArt, MobileSongRow, MobileSongActionSheet, PlaylistNotice },
  data() {
    return {
      playlist: null as Awaited<
        ReturnType<ReturnType<typeof useLibraryStore>['fetchPlaylist']>
      > | null,
      actionsOpen: false,
      activeSong: null as Song | null,
      // See the desktop page: what the last removal did, until dismissed.
      notice: null as Notice | null,
      // This list renders playlist.songs unsorted and unfiltered, so a row
      // index is the playlist position — unlike the desktop table, which
      // has to map its own row indices back (see its onRemoveRequested).
      activeIndex: -1,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    authStore() {
      return useAuthStore()
    },
    /** Same gate the desktop page puts on its table: a shared playlist
     * belongs to whoever made it, and the server refuses the write anyway
     * — offering the entry would only produce an error toast. */
    isOwnPlaylist(): boolean {
      return this.playlist?.owner === this.authStore.username
    },
  },
  created() {
    this.loadPlaylist()
  },
  watch: {
    '$route.params.id'() {
      this.notice = null
      this.loadPlaylist()
    },
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
    openActions(song: Song, index: number) {
      this.activeSong = song
      this.activeIndex = index
      this.actionsOpen = true
    },
    runUndo() {
      this.notice?.undo?.()
    },
    /** See the desktop page's own showing(): the undo offer outlives the
     * page, so neither half of it may write into a playlist that is no
     * longer the one on screen. */
    showing(playlistId: string) {
      const current = this.playlist
      return current && current.id === playlistId ? current : null
    },
    /** See the desktop PlaylistDetailView's identical handler — same
     * service, same optimistic update and undo offer. */
    async onRemove() {
      const playlist = this.playlist
      const song = this.activeSong
      if (!playlist || !song || this.activeIndex < 0) return
      await removeFromPlaylist({
        playlistId: playlist.id,
        indexes: [this.activeIndex],
        songs: [song],
        before: [...playlist.songs],
        apply: (updated) => {
          const current = this.showing(playlist.id)
          if (current) current.songs = updated
        },
        notify: (notice) => {
          if (this.showing(playlist.id)) this.notice = notice
        },
        reload: async () => {
          if (this.showing(playlist.id)) await this.loadPlaylist()
        },
      })
    },
  },
}
</script>

<style scoped>
/* The spinner while the playlist loads, centered in the space its rows
 * will take. */
.mobile-playlist-detail__loading {
  display: flex;
  justify-content: center;
  padding: 24px;
}

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

/* A playlist name can be long; the header stays one line. */
.mobile-header__title .page-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
