<template>
  <v-dialog v-model="visible" max-width="400">
    <v-card>
      <v-card-title>{{ $t('playlists.deleteTitle') }}</v-card-title>
      <v-card-text>{{ $t('playlists.deleteConfirm', { name }) }}</v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="visible = false">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="error" :loading="deleting" @click="confirm">{{ $t('common.delete') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import type { Playlist } from '@/types/library'

/**
 * "Delete this playlist?" — shared by the playlist's own page (where
 * deleting means navigating away afterwards) and the overview's tile menu
 * (where it just disappears from the grid). `deleted` is emitted with the
 * id once it is really gone, so each caller can do its own follow-up.
 */
export default {
  name: 'PlaylistDeleteDialog',
  emits: ['deleted'],
  data() {
    return {
      visible: false,
      deleting: false,
      name: '',
      playlistId: '',
    }
  },
  methods: {
    open(playlist: Playlist): void {
      this.playlistId = playlist.id
      this.name = playlist.name
      this.visible = true
    },
    async confirm(): Promise<void> {
      if (this.deleting) return
      this.deleting = true
      try {
        await useLibraryStore().deletePlaylist(this.playlistId)
        this.visible = false
        this.$emit('deleted', this.playlistId)
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('playlists.deleteTitle'),
          message: error instanceof Error ? error.message : String(error),
        })
        console.error('[playlist-delete] Failed to delete playlist:', error)
      } finally {
        this.deleting = false
      }
    },
  },
}
</script>
