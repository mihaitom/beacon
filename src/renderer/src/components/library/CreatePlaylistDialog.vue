<template>
  <v-dialog v-model="visible" max-width="460" @after-enter="focusName">
    <v-card class="new-playlist">
      <!-- The same head as the smart playlist editor: a stack of records
       - and the name in the title's own type. The sleeves are empty until
       - there is something to put in them; the front one lights up with a
       - name, which is also the moment it can be created. -->
      <div class="new-playlist__band" :class="{ 'new-playlist__band--lit': canCreate }">
        <record-stack
          :covers="[]"
          :size="SLEEVE_SIZE"
          :depth="3"
          :rise="7"
          fallback-icon="mdi-playlist-music"
        />
        <div class="new-playlist__heading">
          <div class="eyebrow-label">{{ $t('playlists.createTitle') }}</div>
          <input
            ref="nameField"
            v-model="name"
            class="detail-title new-playlist__name"
            :placeholder="$t('playlists.namePlaceholder')"
            :aria-label="$t('common.name')"
            maxlength="200"
            spellcheck="false"
            @keyup.enter="confirm"
          />
        </div>
      </div>
      <v-card-text v-if="capabilities.playlistDetails" class="new-playlist__fields">
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
import RecordStack from './RecordStack.vue'
import PlaylistVisibility from './PlaylistVisibility.vue'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import type { PlaylistChanges } from '@/services/subsonic/client'

const SLEEVE_SIZE = 84

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
  components: { RecordStack, PlaylistVisibility },
  emits: ['created'],
  data() {
    return {
      SLEEVE_SIZE,
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
      ;(this.$refs.nameField as HTMLInputElement | undefined)?.focus()
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
.new-playlist__band {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 26px 24px 22px;
  border-bottom: 1px solid var(--beacon-hairline);
}

/* A cover's placeholder fill is see-through, which is fine over a page but
 * here would show the sleeves behind through the front one. */
.new-playlist__band :deep(.record-stack__record) {
  background: rgb(var(--v-theme-surface-bright));
}

.new-playlist__band :deep(.cover-art-fallback) {
  transition: color 0.6s ease;
}

.new-playlist__band--lit :deep(.record-stack__record:first-child .cover-art-fallback) {
  color: rgb(var(--v-theme-primary));
}

.new-playlist__heading {
  flex: 1;
  min-width: 0;
}

/* Well over the 16px floor for anything that takes a cursor. A line rather
 * than a box, so it reads as the title it is about to be. */
.new-playlist__name.detail-title {
  width: 100%;
  margin-top: 6px;
  padding: 2px 0 6px;
  border: 0;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.18);
  outline: none;
  background: none;
  color: inherit;
  font-size: 1.6rem;
  caret-color: rgb(var(--v-theme-primary));
  transition: border-color 0.15s ease;
}

.new-playlist__name::placeholder {
  color: rgba(var(--v-theme-on-surface), 0.38);
}

.new-playlist__name:focus {
  border-bottom-color: rgb(var(--v-theme-primary));
}

.new-playlist__fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 18px;
}

@media (prefers-reduced-motion: reduce) {
  .new-playlist__band :deep(.cover-art-fallback) {
    transition: none;
  }
}
</style>
