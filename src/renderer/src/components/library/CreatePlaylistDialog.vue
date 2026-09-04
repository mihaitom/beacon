<template>
  <v-dialog v-model="visible" max-width="400">
    <v-card>
      <v-card-title>{{ $t('playlists.createTitle') }}</v-card-title>
      <v-card-text>
        <v-text-field
          v-model="name"
          :label="$t('common.name')"
          variant="solo-filled"
          autofocus
          clearable
          @keyup.enter="confirm"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="visible = false">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" :disabled="!name.trim()" :loading="creating" @click="confirm">
          {{ $t('common.create') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'

/**
 * "Create new playlist…", asked for from a context menu and seeded with
 * whatever that menu was about — a song, a selection of them, an album's
 * whole track list. The caller opens it with those songs (open(ids)) and
 * hears back once it worked (`created`); everything else, including the
 * failure toast, is handled here, because it is identical wherever it is
 * asked for.
 */
export default {
  name: 'CreatePlaylistDialog',
  emits: ['created'],
  data() {
    return {
      visible: false,
      name: '',
      creating: false,
      songIds: [] as string[],
    }
  },
  methods: {
    open(songIds: string[]): void {
      this.songIds = songIds
      this.name = ''
      this.visible = true
    },
    async confirm(): Promise<void> {
      const name = this.name.trim()
      if (!name || this.creating) return
      this.creating = true
      try {
        await useLibraryStore().createPlaylist(name, this.songIds)
        this.visible = false
        this.$emit('created')
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('playlists.createTitle'),
          message: error instanceof Error ? error.message : String(error),
        })
        console.error('[create-playlist] Failed to create playlist:', error)
      } finally {
        this.creating = false
      }
    },
  },
}
</script>
