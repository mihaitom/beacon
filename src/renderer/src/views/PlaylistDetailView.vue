<template>
  <v-container v-if="playlist" fluid class="playlist-detail">
    <detail-header
      :cover-art-id="playlist.coverArtId"
      :record-stack="covers"
      fallback-icon="mdi-playlist-music"
      :eyebrow="$t('library.playlist')"
      :title="playlist.name"
    >
      <template v-if="!isOwnPlaylist && playlist.owner" #subtitle>
        {{ $t('playlists.byOwner', { owner: playlist.owner }) }}
      </template>
      <template #meta>
        {{ $t('playlists.songCount', { count: $n(playlist.songs.length) }) }}
        <template v-if="durationLabel"> · {{ durationLabel }}</template>
        <template v-if="playlist.public"> · {{ $t('playlists.public') }}</template>
        <template v-if="playlist.smart"> · {{ $t('playlists.smart') }}</template>
      </template>
      <template v-if="playlist.comment" #description>
        <p class="text-body-medium playlist-comment">{{ playlist.comment }}</p>
      </template>
      <template #actions>
        <div class="playlist-actions">
          <v-btn
            color="primary"
            rounded="pill"
            prepend-icon="mdi-play"
            :disabled="!shownSongs.length"
            @click="playAll"
          >
            {{ $t('library.play') }}
          </v-btn>
          <preview-button :songs="shownSongs" />
        </div>
      </template>
      <template #top-right>
        <v-btn
          v-if="canEditRules"
          icon="mdi-tune-variant"
          variant="text"
          :title="$t('smartPlaylists.editRules')"
          :aria-label="$t('smartPlaylists.editRules')"
          :to="`/playlists/${playlist.id}/rules`"
        />
        <v-btn
          v-if="canManage"
          icon="mdi-pencil-outline"
          variant="text"
          :title="$t('common.edit')"
          @click="openEdit"
        />
        <v-btn
          v-if="canManage"
          icon="mdi-delete-outline"
          variant="text"
          :title="$t('common.delete')"
          :aria-label="$t('common.delete')"
          @click="openDelete"
        />
      </template>
    </detail-header>

    <playlist-notice v-if="notice" :notice="notice" @undo="runUndo" @dismiss="notice = null" />

    <playlist-edit-dialog ref="editDialog" @saved="onRenamed" />
    <playlist-delete-dialog ref="deleteDialog" @deleted="$router.push('/playlists')" />

    <!-- Reachable both by emptying a playlist from the track menu and by
     - opening one that was created empty in the first place (see
     - capabilities.ts's emptyPlaylistCreation) — without this the page
     - ends on a column-heading row with nothing under it. -->
    <empty-state
      v-if="!playlist.songs.length"
      :icon="playlist.smart ? 'mdi-playlist-star' : 'mdi-playlist-music-outline'"
      :title="playlist.smart ? $t('playlists.smartEmpty') : $t('playlists.noSongsYet')"
      :text="playlist.smart ? undefined : $t('playlists.emptyHint')"
    />
    <template v-else>
      <sticky-filter :z-index="3" :fade="false" @resize="stickyHeaderHeight = $event">
        <div class="library-filter">
          <v-text-field
            v-model="filterQuery"
            :placeholder="$t('search.label')"
            :aria-label="$t('search.label')"
            prepend-inner-icon="mdi-magnify"
            variant="solo-filled"
            density="compact"
            rounded="pill"
            flat
            clearable
            hide-details
            class="library-search"
          >
            <template #append-inner><exact-match-switch /></template>
          </v-text-field>
          <div class="library-controls">
            <library-filter-menu v-model="filters" :items="playlist.songs" :fields="filterFields" />
            <library-sort-select
              :model-value="sortValue"
              :items="sortItems"
              :direction="tableSort ? sort.direction : null"
              @update:model-value="pickSort"
              @toggle-direction="toggleDirection"
            />
          </div>
        </div>
      </sticky-filter>
      <!-- Reordering and removing: only your own playlists. A shared one
       - belongs to whoever made it, and the server rejects the write anyway
       - (Navidrome answers createPlaylist for someone else's playlist with a
       - not-authorized error). Your own smart playlist is refused the same
       - way: its rules decide the songs. Dragging also needs the whole list
       - on screen: between two rows of a search result is no place in the
       - playlist. -->
      <song-table
        v-if="filteredSongs.length"
        :songs="filteredSongs"
        :sort="tableSort"
        sectioned
        sticky-header
        :style="{ '--sticky-header-offset': `${stickyHeaderHeight}px` }"
        :reorderable="songsEditable && !narrowed"
        :removable="songsEditable"
        @reorder="onReorder"
        @remove="onRemove"
      />
      <empty-state
        v-else
        :icon="debouncedQuery ? 'mdi-magnify-close' : 'mdi-music-note-off'"
        :title="
          debouncedQuery
            ? $t('library.noSongsForQuery', { query: debouncedQuery })
            : $t('library.noSongsFound')
        "
      />
    </template>
  </v-container>
  <v-container v-else>
    <page-loader v-if="libraryStore.loading" />
    <v-alert v-else-if="libraryStore.error" type="error" variant="tonal">
      {{ libraryStore.error }}
    </v-alert>
  </v-container>
</template>

<script lang="ts">
import { formatTotalDuration } from '@/services/totalDuration'
import EmptyState from '@/components/EmptyState.vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import DetailHeader from '@/components/library/DetailHeader.vue'
import SongTable from '@/components/library/SongTable.vue'
import PlaylistEditDialog from '@/components/library/PlaylistEditDialog.vue'
import PlaylistDeleteDialog from '@/components/library/PlaylistDeleteDialog.vue'
import PlaylistNotice from '@/components/library/PlaylistNotice.vue'
import PreviewButton from '@/components/library/PreviewButton.vue'
import PageLoader from '@/components/PageLoader.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import ExactMatchSwitch from '@/components/library/ExactMatchSwitch.vue'
import LibraryFilterMenu from '@/components/library/LibraryFilterMenu.vue'
import LibrarySortSelect from '@/components/library/LibrarySortSelect.vue'
import { songBrowsingMixin } from '@/components/library/songBrowsing'
import { rankByMatch } from '@/services/textSearch'
import { filterSongs, sortSongs } from '@/services/library/songBrowse'
import { activeFilterCount } from '@/services/library/libraryFilter'
import { coversOf } from '@/services/library/playlistSummary'
import {
  positionsIn,
  removeFromPlaylist,
  type PlaylistNotice as Notice,
} from '@/services/library/playlistRemoval'
import { canManagePlaylist, isOwnedBy } from '@/services/library/playlistOwnership'
import type { Playlist, Song } from '@/types/library'

export default {
  name: 'PlaylistDetailView',
  components: {
    EmptyState,
    DetailHeader,
    SongTable,
    PlaylistEditDialog,
    PlaylistDeleteDialog,
    PlaylistNotice,
    PageLoader,
    PreviewButton,
    StickyFilter,
    ExactMatchSwitch,
    LibraryFilterMenu,
    LibrarySortSelect,
  },
  mixins: [songBrowsingMixin],
  data() {
    return {
      ownOrderLabel: 'playlists.sortPlaylistOrder',
      // See GenreDetailView.vue's identical field.
      stickyHeaderHeight: 0,
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
      return !!this.playlist && isOwnedBy(this.playlist, this.authStore.username)
    },
    canManage(): boolean {
      return (
        !!this.playlist &&
        canManagePlaylist(this.playlist, this.authStore.username, this.authStore.capabilities)
      )
    },
    /** Navidrome lets only the owner change the rules. */
    canEditRules(): boolean {
      return (
        this.authStore.capabilities.smartPlaylistEditor &&
        this.isOwnPlaylist &&
        !!this.playlist?.smart
      )
    },
    songsEditable(): boolean {
      return this.isOwnPlaylist && !this.playlist?.readonly
    },
    covers(): string[] {
      return this.playlist ? coversOf(this.playlist) : []
    },
    browsedSongs(): Song[] {
      return filterSongs(this.playlist?.songs ?? [], this.filters)
    },
    filteredSongs(): Song[] {
      const query = this.debouncedQuery
      if (!query.trim()) return this.browsedSongs
      const ranked = rankByMatch(
        this.browsedSongs,
        query,
        (song) => [
          { text: song.title, weight: 2 },
          { text: song.artist },
          { text: song.album, weight: 0.5 },
        ],
        { exact: this.libraryStore.searchExact },
      )
      if (this.byRelevance) return ranked
      // Another order was picked for the matches: they are only narrowed.
      const matches = new Set(ranked)
      return this.browsedSongs.filter((song) => matches.has(song))
    },
    narrowed(): boolean {
      return Boolean(this.debouncedQuery.trim()) || activeFilterCount(this.filters) > 0
    },
    /** What is on screen, in that order: what Play and Preview mean. */
    shownSongs(): Song[] {
      return this.tableSort ? sortSongs(this.filteredSongs, this.tableSort) : this.filteredSongs
    },
    // Summed from the tracks, not the playlist's own duration — which,
    // like the songCount beside it in the heading, is what the server sent
    // and is stale the moment a row is removed here. The heading has to
    // move with the rows under it rather than a round trip later.
    durationLabel(): string {
      const seconds = this.playlist?.songs.reduce((total, song) => total + song.duration, 0) ?? 0
      return formatTotalDuration(seconds, this.$t)
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
      this.resetBrowsing()
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
    onRenamed(saved: { name: string; public: boolean; comment: string; ownerChanged: boolean }) {
      if (!this.playlist) return
      // Whether its songs can be changed went with the owner, and only the
      // server says what that now is.
      if (saved.ownerChanged) {
        void this.loadPlaylist()
        return
      }
      this.playlist.name = saved.name
      this.playlist.public = saved.public
      this.playlist.comment = saved.comment
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
     * phone's own playlist page does exactly the same thing. Positions are
     * worked out here because the table counts in the list it was given,
     * which a search or filter may have narrowed, and the server counts in
     * the whole playlist. */
    async onRemove({ songs }: { songs: Song[] }) {
      const playlist = this.playlist
      if (!playlist) return
      await removeFromPlaylist({
        playlistId: playlist.id,
        indexes: positionsIn(playlist.songs, songs),
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
      if (!this.shownSongs.length) return
      // pinFirst: false — this is "play the whole playlist", not a specific
      // song pick, so shuffle (if on) should be free to reorder the first
      // song too instead of always starting on track 1.
      // peek: replaces the queue with more than one song — see
      // peekQueueDrawer()'s own comment for the rule.
      await usePlaybackStore().playSongList(this.shownSongs, 0, false, this.shownSongs.length > 1)
    },
  },
}
</script>

<style scoped>
/* Clear of the index bar down the right edge, while a long list has one. */
.playlist-detail:has(.song-table--with-alphabet-bar) .library-filter {
  margin-right: 40px;
}

/* Play and Preview side by side, as on the album page. */
.playlist-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* Clipped, not scrolled: a long description must not push the buttons out
 * of a header whose height follows the window. */
.playlist-comment {
  display: -webkit-box;
  max-width: 70ch;
  margin: 6px 0 0;
  overflow: hidden;
  white-space: pre-line;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
</style>
