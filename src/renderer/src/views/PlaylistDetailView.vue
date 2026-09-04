<template>
  <v-container v-if="playlist" fluid>
    <detail-header
      :cover-art-id="playlist.coverArtId"
      :size="200"
      fallback-icon="mdi-playlist-music"
      :eyebrow="$t('library.playlist')"
      :title="playlist.name"
    >
      <template v-if="!isOwnPlaylist" #subtitle>
        {{ $t('playlists.byOwner', { owner: playlist.owner }) }}
      </template>
      <template #meta>
        {{ $t('playlists.songCount', { count: playlist.songCount }) }}
        <template v-if="durationLabel"> · {{ durationLabel }}</template>
        <template v-if="playlist.public"> · {{ $t('playlists.public') }}</template>
      </template>
      <template #actions>
        <v-btn
          color="primary"
          rounded="pill"
          prepend-icon="mdi-play"
          :disabled="!playlist.songs.length"
          @click="playAll"
        >
          {{ $t('library.play') }}
        </v-btn>
      </template>
      <template #top-right>
        <v-btn
          v-if="isOwnPlaylist"
          icon="mdi-pencil-outline"
          variant="text"
          :title="$t('common.edit')"
          @click="openEdit"
        />
        <v-btn icon="mdi-delete-outline" variant="text" @click="openDelete" />
      </template>
    </detail-header>

    <playlist-edit-dialog ref="editDialog" @saved="onRenamed" />
    <playlist-delete-dialog ref="deleteDialog" @deleted="$router.push('/playlists')" />

    <!-- Only your own playlists: a shared one belongs to whoever made it,
     - and the server rejects the write anyway (Navidrome answers
     - createPlaylist for someone else's playlist with a not-authorized
     - error). -->
    <song-table
      :songs="playlist.songs"
      :queue-whole-list="false"
      :default-sort-key="null"
      :reorderable="isOwnPlaylist"
      show-cover
      show-album
      show-genre
      show-year
      show-play-count
      show-format
      @reorder="onReorder"
    />
  </v-container>
  <v-container v-else>
    <page-loader v-if="libraryStore.loading" />
    <v-alert v-else-if="libraryStore.error" type="error" variant="tonal">
      {{ libraryStore.error }}
    </v-alert>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import DetailHeader from '@/components/library/DetailHeader.vue'
import SongTable from '@/components/library/SongTable.vue'
import PlaylistEditDialog from '@/components/library/PlaylistEditDialog.vue'
import PlaylistDeleteDialog from '@/components/library/PlaylistDeleteDialog.vue'
import PageLoader from '@/components/PageLoader.vue'
import type { Playlist } from '@/types/library'

export default {
  name: 'PlaylistDetailView',
  components: { DetailHeader, SongTable, PlaylistEditDialog, PlaylistDeleteDialog, PageLoader },
  data() {
    return {
      playlist: null as Awaited<
        ReturnType<ReturnType<typeof useLibraryStore>['fetchPlaylist']>
      > | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    authStore() {
      return useAuthStore()
    },
    isOwnPlaylist(): boolean {
      return this.playlist?.owner === this.authStore.username
    },
    durationLabel(): string {
      const seconds = this.playlist?.duration
      if (!seconds) return ''
      const total = Math.round(seconds)
      const hours = Math.floor(total / 3600)
      const minutes = Math.round((total % 3600) / 60)
      if (hours > 0) return this.$t('playlists.durationHours', { hours, minutes })
      return this.$t('playlists.durationMinutes', { minutes })
    },
  },
  created() {
    this.loadPlaylist()
  },
  watch: {
    '$route.params.id': 'loadPlaylist',
  },
  methods: {
    async loadPlaylist() {
      const id = this.$route.params.id as string
      try {
        const playlist = await this.libraryStore.fetchPlaylist(id)
        // A newer navigation may have already resolved and moved the route
        // on while this fetch was in flight — don't let a slower, stale
        // response overwrite what's actually being viewed now.
        if (this.$route.params.id === id) this.playlist = playlist
      } catch (error) {
        if (this.$route.params.id !== id) return
        console.error('[playlist-detail] Failed to load playlist:', error)
      }
    },
    openEdit() {
      if (!this.playlist) return
      ;(this.$refs.editDialog as { open: (playlist: Playlist) => void } | undefined)?.open(
        this.playlist,
      )
    },
    openDelete() {
      if (!this.playlist) return
      ;(this.$refs.deleteDialog as { open: (playlist: Playlist) => void } | undefined)?.open(
        this.playlist,
      )
    },
    /** This view holds its own copy of the playlist (fetched by id, not the
     * store's list entry), so the new name has to be written into it here —
     * the store's own list is already updated by the dialog. */
    onRenamed({ name, public: isPublic }: { name: string; public: boolean }) {
      if (!this.playlist) return
      this.playlist.name = name
      this.playlist.public = isPublic
    },
    /** Moves a song and saves the result. The row moves first and is put
     * back if the save fails — a drag that only takes effect a round trip
     * later reads as a dropped drag, and the drop position is already
     * gone from the screen by the time an error could explain itself. */
    async onReorder({ from, to }: { from: number; to: number }) {
      const playlist = this.playlist
      if (!playlist) return
      const before = [...playlist.songs]
      const reordered = [...playlist.songs]
      const [moved] = reordered.splice(from, 1)
      if (!moved) return
      reordered.splice(to, 0, moved)
      playlist.songs = reordered
      try {
        await this.libraryStore.reorderPlaylist(
          playlist.id,
          reordered.map((song) => song.id),
        )
      } catch (error) {
        // Assigning `before` back wholesale rather than moving the row
        // back: another change may have landed in between (a song removed
        // from its own context menu), and this is the state the server
        // still has either way.
        playlist.songs = before
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('playlists.reorderFailed'),
          message: error instanceof Error ? error.message : String(error),
        })
        console.error('[playlist-detail] Failed to reorder playlist:', error)
      }
    },
    async playAll() {
      if (!this.playlist?.songs.length) return
      // pinFirst: false — this is "play the whole playlist", not a specific
      // song pick, so shuffle (if on) should be free to reorder the first
      // song too instead of always starting on track 1.
      // peek: replaces the queue with more than one song — see
      // peekQueueDrawer()'s own comment for the rule.
      await usePlaybackStore().playSongList(
        this.playlist.songs,
        0,
        false,
        this.playlist.songs.length > 1,
      )
    },
  },
}
</script>
