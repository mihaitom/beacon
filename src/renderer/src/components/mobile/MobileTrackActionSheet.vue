<template>
  <v-bottom-sheet :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <v-card v-if="track">
      <div class="mobile-track-actions__header d-flex align-center">
        <cover-art :cover-art-id="track.coverArtId" :size="40" class="mr-3" />
        <div class="min-width-0">
          <div class="text-body-2 text-truncate">{{ track.title }}</div>
          <div class="text-caption text-medium-emphasis text-truncate">{{ track.artist }}</div>
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
        <v-list-item v-if="authStore.capabilities.trackRadio" @click="startTrackRadio">
          <template #prepend><v-icon icon="mdi-radio-tower" /></template>
          <v-list-item-title>{{ $t('library.trackRadio') }}</v-list-item-title>
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
      <v-list v-else density="compact" class="mobile-track-actions__playlists">
        <v-list-item @click="createPlaylistWithTrack">
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
import type { Track } from '@/types/library'

export default {
  name: 'MobileTrackActionSheet',
  components: { CoverArt },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
    track: {
      type: Object as () => Track | null,
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
      const track = this.track
      if (!track) return
      this.act(() => this.playbackStore.playTrackList([track], 0))
    },
    playNext() {
      const track = this.track
      if (!track) return
      this.act(() => this.playbackStore.queueNext([track]))
    },
    startTrackRadio() {
      const track = this.track
      if (!track) return
      this.act(() => this.playbackStore.startTrackRadio(track))
    },
    addToQueue() {
      const track = this.track
      if (!track) return
      this.act(() => this.playbackStore.addToQueue([track]))
    },
    addToPlaylist(playlistId: string) {
      const track = this.track
      if (!track) return
      this.act(() => this.libraryStore.addToPlaylist(playlistId, [track.id]))
    },
    createPlaylistWithTrack() {
      const track = this.track
      if (!track) return
      this.act(() => this.libraryStore.createPlaylist(track.title, [track.id]))
    },
  },
}
</script>

<style scoped>
.mobile-track-actions__header {
  padding: 16px 16px 8px;
}

.mobile-track-actions__playlists {
  max-height: 50vh;
  overflow-y: auto;
}

.min-width-0 {
  min-width: 0;
}
</style>
