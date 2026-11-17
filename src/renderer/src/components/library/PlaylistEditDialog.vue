<template>
  <v-dialog v-model="visible" max-width="460">
    <v-card>
      <playlist-dialog-head
        v-model="name"
        :eyebrow="$t('playlists.editTitle')"
        :covers="covers"
        @confirm="save"
      />
      <v-card-text v-if="capabilities.playlistDetails" class="playlist-edit__fields">
        <v-textarea
          v-model="comment"
          :label="$t('playlists.comment')"
          variant="solo-filled"
          rows="2"
          auto-grow
          hide-details
        />
        <v-select
          v-if="owners.length"
          v-model="ownerId"
          :items="owners"
          :label="$t('playlists.owner')"
          variant="solo-filled"
          hide-details
        />
        <v-btn
          v-else-if="ownerLoginNeeded"
          variant="tonal"
          prepend-icon="mdi-account-key-outline"
          @click="signInForOwner"
        >
          {{ $t('playlists.ownerLogin') }}
        </v-btn>
        <playlist-visibility v-model="isPublic" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="visible = false">{{ $t('common.cancel') }}</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          rounded="pill"
          prepend-icon="mdi-check"
          :disabled="!name.trim()"
          :loading="saving"
          @click="save"
        >
          {{ $t('common.save') }}
        </v-btn>
      </v-card-actions>
    </v-card>
    <navidrome-password-dialog ref="password" />
  </v-dialog>
</template>

<script lang="ts">
import NavidromePasswordDialog from '@/components/smartPlaylist/NavidromePasswordDialog.vue'
import PlaylistDialogHead from './PlaylistDialogHead.vue'
import PlaylistVisibility from './PlaylistVisibility.vue'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { usePlaylistSummariesStore } from '@/stores/playlistSummaries'
import { coversOf } from '@/services/library/playlistSummary'
import {
  NavidromeLoginRequired,
  getNavidromePlaylist,
  listNavidromeUsers,
  setNavidromePlaylistOwner,
} from '@/services/navidrome/client'
import type { Playlist } from '@/types/library'
import type { PlaylistChanges } from '@/services/subsonic/client'

/**
 * Editing a playlist's name, description, public flag and, for a Navidrome
 * admin, its owner - asked for from the playlist's own page and from a
 * card's context menu on the playlists overview. One component rather than
 * the same form in both, since the question and what it does with the
 * answer are identical.
 *
 * `saved` carries the new values so a caller holding its own copy of the
 * playlist (the detail page's `playlist` object) can update it without
 * re-fetching; the store's own list is updated by updatePlaylist() itself.
 */
export default {
  name: 'PlaylistEditDialog',
  components: { NavidromePasswordDialog, PlaylistDialogHead, PlaylistVisibility },
  emits: ['saved'],
  data() {
    return {
      visible: false,
      saving: false,
      name: '',
      comment: '',
      isPublic: false,
      covers: [] as string[],
      playlistId: '',
      owners: [] as { title: string; value: string }[],
      ownerId: '',
      ownerLoginNeeded: false,
      // What the form started from: only what differs from it is sent.
      original: { name: '', comment: '', public: false, ownerId: '' },
    }
  },
  computed: {
    capabilities() {
      return useAuthStore().capabilities
    },
  },
  methods: {
    open(playlist: Playlist): void {
      this.playlistId = playlist.id
      this.name = playlist.name
      this.comment = playlist.comment ?? ''
      this.isPublic = playlist.public
      this.covers = coversOf(playlist, usePlaylistSummariesStore().summaryFor(playlist))
      this.owners = []
      this.ownerId = ''
      this.ownerLoginNeeded = false
      this.original = {
        name: playlist.name,
        comment: this.comment,
        public: playlist.public,
        ownerId: '',
      }
      this.visible = true
      if (this.capabilities.playlistAdmin) void this.loadOwners(playlist.id)
    },
    /** The form works without the field: a failure here costs only the
     * owner, not the name and description the dialog was opened for. */
    async loadOwners(id: string): Promise<void> {
      try {
        const [users, playlist] = await Promise.all([
          listNavidromeUsers(),
          getNavidromePlaylist(id),
        ])
        if (id !== this.playlistId) return
        this.owners = users.map((user) => ({ title: user.name, value: user.id }))
        this.ownerId = playlist.ownerId
        this.original.ownerId = playlist.ownerId
      } catch (error) {
        if (error instanceof NavidromeLoginRequired) this.ownerLoginNeeded = true
        else console.error('[playlist-edit] Failed to load the owners:', error)
      }
    },
    askPassword(): Promise<boolean> {
      return (this.$refs.password as InstanceType<typeof NavidromePasswordDialog>).ask()
    },
    async signInForOwner(): Promise<void> {
      if (!(await this.askPassword())) return
      this.ownerLoginNeeded = false
      await this.loadOwners(this.playlistId)
    },
    changes(name: string): PlaylistChanges {
      const changes: PlaylistChanges = {}
      if (name !== this.original.name) changes.name = name
      if (this.capabilities.playlistDetails) {
        if (this.comment !== this.original.comment) changes.comment = this.comment
        if (this.isPublic !== this.original.public) changes.public = this.isPublic
      }
      return changes
    },
    async save(): Promise<void> {
      const name = this.name.trim()
      if (!name || this.saving) return
      this.saving = true
      let signedIn = false
      try {
        const changes = this.changes(name)
        if (Object.keys(changes).length) {
          await useLibraryStore().updatePlaylist(this.playlistId, changes)
          // Done, should the owner below need another attempt.
          Object.assign(this.original, changes)
        }
        const ownerChanged = !!this.ownerId && this.ownerId !== this.original.ownerId
        if (ownerChanged) {
          await setNavidromePlaylistOwner(this.playlistId, this.ownerId)
          this.original.ownerId = this.ownerId
          await useLibraryStore().refreshPlaylistCache()
        }
        this.visible = false
        this.$emit('saved', {
          id: this.playlistId,
          name,
          public: this.isPublic,
          comment: this.comment,
          ownerChanged,
        })
      } catch (error) {
        if (error instanceof NavidromeLoginRequired) {
          signedIn = await this.askPassword()
          return
        }
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('playlists.editTitle'),
          message: error instanceof Error ? error.message : String(error),
        })
        console.error('[playlist-edit] Failed to save playlist:', error)
      } finally {
        this.saving = false
        if (signedIn) void this.save()
      }
    },
  },
}
</script>

<style scoped>
.playlist-edit__fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 18px;
}
</style>
