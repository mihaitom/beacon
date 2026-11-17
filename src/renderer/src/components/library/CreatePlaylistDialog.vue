<template>
  <v-dialog v-model="visible" max-width="460" @after-enter="focusName">
    <v-card>
      <playlist-dialog-head
        ref="head"
        v-model="name"
        :eyebrow="$t('playlists.createTitle')"
        @confirm="confirm"
      />
      <v-card-text v-if="capabilities.playlistDetails" class="create-playlist__fields">
        <v-textarea
          v-model="comment"
          :label="$t('playlists.comment')"
          variant="solo-filled"
          rows="2"
          auto-grow
          hide-details
        />
        <playlist-visibility v-model="isPublic" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="visible = false">{{ $t('common.cancel') }}</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          rounded="pill"
          prepend-icon="mdi-plus"
          :disabled="!canCreate"
          :loading="creating"
          @click="confirm"
        >
          {{ $t('common.create') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import PlaylistDialogHead from './PlaylistDialogHead.vue'
import PlaylistVisibility from './PlaylistVisibility.vue'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import type { PlaylistChanges } from '@/services/subsonic/client'

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
  components: { PlaylistDialogHead, PlaylistVisibility },
  emits: ['created'],
  data() {
    return {
      visible: false,
      name: '',
      comment: '',
      isPublic: false,
      creating: false,
      songIds: [] as string[],
    }
  },
  computed: {
    capabilities() {
      return useAuthStore().capabilities
    },
    canCreate(): boolean {
      return !!this.name.trim()
    },
  },
  methods: {
    open(songIds: string[]): void {
      this.songIds = songIds
      this.name = ''
      this.comment = ''
      this.isPublic = false
      this.visible = true
    },
    focusName(): void {
      ;(this.$refs.head as InstanceType<typeof PlaylistDialogHead> | undefined)?.focus()
    },
    async confirm(): Promise<void> {
      const name = this.name.trim()
      if (!name || this.creating) return
      this.creating = true
      try {
        const details: PlaylistChanges = {}
        if (this.comment.trim()) details.comment = this.comment.trim()
        if (this.isPublic) details.public = true
        await useLibraryStore().createPlaylist(name, this.songIds, details)
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

<style scoped>
.create-playlist__fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 18px;
}
</style>
