<template>
  <v-dialog v-model="visible" max-width="400">
    <v-card>
      <v-card-title>{{ $t('playlists.editTitle') }}</v-card-title>
      <v-card-text>
        <v-text-field
          v-model="name"
          :label="$t('common.name')"
          variant="solo-filled"
          clearable
          @keyup.enter="save"
        />
        <v-switch v-model="isPublic" :label="$t('playlists.public')" color="primary" hide-details />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="visible = false">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" :disabled="!name.trim()" :loading="saving" @click="save">
          {{ $t('common.save') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import type { Playlist } from '@/types/library'

/**
 * Renaming a playlist (and its public/private flag) — asked for from the
 * playlist's own page and from a tile's context menu on the playlists
 * overview. One component rather than the same form in both, since the
 * question and what it does with the answer are identical.
 *
 * `saved` carries the new values so a caller holding its own copy of the
 * playlist (the detail page's `playlist` object) can update it without
 * re-fetching; the store's own list is updated by updatePlaylist() itself.
 */
export default {
  name: 'PlaylistEditDialog',
  emits: ['saved'],
  data() {
    return {
      visible: false,
      saving: false,
      name: '',
      isPublic: false,
      playlistId: '',
    }
  },
  methods: {
    open(playlist: Playlist): void {
      this.playlistId = playlist.id
      this.name = playlist.name
      this.isPublic = playlist.public
      this.visible = true
    },
    async save(): Promise<void> {
      const name = this.name.trim()
      if (!name || this.saving) return
      const isPublic = this.isPublic
      this.saving = true
      try {
        await useLibraryStore().updatePlaylist(this.playlistId, { name, public: isPublic })
        this.visible = false
        this.$emit('saved', { id: this.playlistId, name, public: isPublic })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('playlists.editTitle'),
          message: error instanceof Error ? error.message : String(error),
        })
        console.error('[playlist-edit] Failed to save playlist:', error)
      } finally {
        this.saving = false
      }
    },
  },
}
</script>
