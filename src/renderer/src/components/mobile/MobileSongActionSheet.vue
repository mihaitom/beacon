<template>
  <v-bottom-sheet
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card v-if="song">
      <div class="mobile-song-actions__header d-flex align-center">
        <cover-art :cover-art-id="song.coverArtId" :size="40" class="mr-3" />
        <div class="min-width-0">
          <div class="text-body-2 text-truncate">{{ song.title }}</div>
          <div class="text-caption text-medium-emphasis text-truncate">{{ song.artist }}</div>
        </div>
      </div>
      <v-list v-if="!playlistPicker" density="compact">
        <v-list-item @click="playNow">
          <template #prepend><v-icon icon="mdi-play" /></template>
          <v-list-item-title>{{ $t('library.play') }}</v-list-item-title>
        </v-list-item>
        <v-list-item @click="playNext">
          <template #prepend><v-icon icon="mdi-skip-next-outline" /></template>
          <v-list-item-title>{{ $t('library.playNext') }}</v-list-item-title>
        </v-list-item>
        <v-list-item v-if="authStore.capabilities.songRadio" @click="startSongRadio">
          <template #prepend><v-icon icon="mdi-radio-tower" /></template>
          <v-list-item-title>{{ $t('library.songRadio') }}</v-list-item-title>
        </v-list-item>
        <v-divider />
        <v-list-item @click="addToQueue">
          <template #prepend><v-icon icon="mdi-playlist-plus" /></template>
          <v-list-item-title>{{ $t('common.addToQueue') }}</v-list-item-title>
        </v-list-item>
        <v-list-item @click="playlistPicker = true">
          <template #prepend><v-icon icon="mdi-playlist-music" /></template>
          <v-list-item-title>{{ $t('common.addToPlaylistMenu') }}</v-list-item-title>
          <template #append><v-icon icon="mdi-menu-right" /></template>
        </v-list-item>
      </v-list>
      <v-list v-else density="compact" class="mobile-song-actions__playlists">
        <v-list-item @click="createPlaylistWithSong">
          <template #prepend><v-icon icon="mdi-plus" /></template>
          <v-list-item-title>{{ $t('common.createNewPlaylist') }}</v-list-item-title>
        </v-list-item>
        <template v-if="libraryStore.playlists.length">
          <v-divider />
          <v-list-item
            v-for="playlist in libraryStore.playlists"
            :key="playlist.id"
            @click="addToPlaylist(playlist.id)"
          >
            <v-list-item-title>{{ playlist.name }}</v-list-item-title>
          </v-list-item>
        </template>
      </v-list>
    </v-card>
  </v-bottom-sheet>
</template>

<script lang="ts">
import CoverArt from '@/components/library/CoverArt.vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import type { Song } from '@/types/library'

export default {
  name: 'MobileSongActionSheet',
  components: { CoverArt },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
    song: {
      type: Object as () => Song | null,
      default: null,
    },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      playlistPicker: false,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    libraryStore() {
      return useLibraryStore()
    },
    authStore() {
      return useAuthStore()
    },
  },
  watch: {
    modelValue(open: boolean) {
      if (open) {
        this.playlistPicker = false
        if (this.libraryStore.playlists.length === 0) void this.libraryStore.fetchPlaylists()
      }
    },
  },
  methods: {
    close() {
      this.$emit('update:modelValue', false)
    },
    act(fn: () => unknown) {
      void fn()
      this.close()
    },
    playNow() {
      const song = this.song
      if (!song) return
      this.act(() => this.playbackStore.playSongList([song], 0))
    },
    playNext() {
      const song = this.song
      if (!song) return
      this.act(() => this.playbackStore.queueNext([song]))
    },
    startSongRadio() {
      const song = this.song
      if (!song) return
      this.act(() => this.playbackStore.startSongRadio(song))
    },
    addToQueue() {
      const song = this.song
      if (!song) return
      this.act(() => this.playbackStore.addToQueue([song]))
    },
    addToPlaylist(playlistId: string) {
      const song = this.song
      if (!song) return
      this.act(() => this.libraryStore.addToPlaylist(playlistId, [song.id]))
    },
    createPlaylistWithSong() {
      const song = this.song
      if (!song) return
      this.act(() => this.libraryStore.createPlaylist(song.title, [song.id]))
    },
  },
}
</script>

<style scoped>
.mobile-song-actions__header {
  padding: 16px 16px 8px;
}

.mobile-song-actions__playlists {
  max-height: 50vh;
  overflow-y: auto;
}

.min-width-0 {
  min-width: 0;
}
</style>
