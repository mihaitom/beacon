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
        {{ $t('playlists.songCount', { count: playlist.songs.length }) }}
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

    <playlist-notice v-if="notice" :notice="notice" @undo="runUndo" @dismiss="notice = null" />

    <playlist-edit-dialog ref="editDialog" @saved="onRenamed" />
    <playlist-delete-dialog ref="deleteDialog" @deleted="$router.push('/playlists')" />

    <!-- Reachable both by emptying a playlist from the track menu and by
     - opening one that was created empty in the first place (see
     - capabilities.ts's emptyPlaylistCreation) — without this the page
     - ends on a column-heading row with nothing under it. -->
    <v-alert v-if="!playlist.songs.length" type="info" variant="tonal" class="view-notice">
      {{ $t('playlists.noSongsYet') }}
    </v-alert>
    <!-- Reordering and removing: only your own playlists. A shared one
     - belongs to whoever made it, and the server rejects the write anyway
     - (Navidrome answers createPlaylist for someone else's playlist with a
     - not-authorized error). -->
    <song-table
      v-else
      :songs="playlist.songs"
      :queue-whole-list="false"
      :default-sort-key="null"
      :reorderable="isOwnPlaylist"
      :removable="isOwnPlaylist"
      @reorder="onReorder"
      @remove="onRemove"
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
import PlaylistNotice from '@/components/library/PlaylistNotice.vue'
import PageLoader from '@/components/PageLoader.vue'
import {
  removeFromPlaylist,
  type PlaylistNotice as Notice,
} from '@/services/library/playlistRemoval'
import type { Playlist, Song } from '@/types/library'

export default {
  name: 'PlaylistDetailView',
  components: {
    DetailHeader,
    SongTable,
    PlaylistEditDialog,
    PlaylistDeleteDialog,
    PlaylistNotice,
    PageLoader,
  },
  data() {
    return {
      playlist: null as Awaited<
        ReturnType<ReturnType<typeof useLibraryStore>['fetchPlaylist']>
      > | null,
      // What the last removal did, shown above the list until it is
      // dismissed or the page moves on (see PlaylistNotice.vue).
      notice: null as Notice | null,
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
    // Summed from the tracks, not the playlist's own duration — which,
    // like the songCount beside it in the heading, is what the server sent
    // and is stale the moment a row is removed here. The heading has to
    // move with the rows under it rather than a round trip later.
    durationLabel(): string {
      const seconds = this.playlist?.songs.reduce((total, song) => total + song.duration, 0)
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
    '$route.params.id'() {
      // A notice is about the playlist it was made on, and so is the undo
      // it offers — neither carries over to the next one.
      this.notice = null
      this.loadPlaylist()
    },
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
    /** The playlist on screen, if it is still the one a removal was
     * started on. Asked at the time of use rather than captured: the page
     * re-reads the playlist after every write (so the object changes), and
     * the undo offer outlives the page by up to 20 seconds, by which time
     * the route may be showing a different playlist entirely. */
    showing(playlistId: string) {
      const current = this.playlist
      return current && current.id === playlistId ? current : null
    },
    /** Drops the rows the menu was used on. The optimistic update, the
     * undo offer and the failure handling all live in the service — the
     * phone's own playlist page does exactly the same thing. */
    async onRemove({ indexes, songs }: { indexes: number[]; songs: Song[] }) {
      const playlist = this.playlist
      if (!playlist) return
      await removeFromPlaylist({
        playlistId: playlist.id,
        indexes,
        songs,
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
    runUndo() {
      this.notice?.undo?.()
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
