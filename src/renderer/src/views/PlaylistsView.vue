<template>
  <v-container fluid>
    <detail-header fallback-icon="mdi-playlist-music" :title="$t('playlists.title')">
      <template v-if="filteredPlaylists.length" #meta>
        {{ filteredPlaylists.length }}
        {{
          filteredPlaylists.length === 1 ? $t('playlists.playlist1') : $t('playlists.playlistsN')
        }}
      </template>
      <template v-if="authStore.capabilities.emptyPlaylistCreation" #actions>
        <v-btn
          prepend-icon="mdi-plus"
          color="primary"
          rounded="pill"
          @click="createDialog = true"
          >{{ $t('playlists.newPlaylist') }}</v-btn
        >
      </template>
    </detail-header>

    <sticky-filter>
      <v-text-field
        v-model="filterQuery"
        :label="$t('search.label')"
        prepend-inner-icon="mdi-magnify"
        variant="solo-filled"
        density="compact"
        clearable
        class="library-search"
      />
    </sticky-filter>
    <v-alert v-if="libraryStore.error" type="error" variant="tonal" class="view-notice">
      {{ libraryStore.error }}
    </v-alert>
    <!-- Placeholders in the grid's own place, not a spinner above it: a
     - spinner in the flow pushed everything below it down while it was
     - there. Only while there is genuinely nothing to show yet — the flag
     - is the library store's own, so any background fetch (a tile menu
     - loading a playlist's songs) sets it too, and swapping a full grid for
     - placeholders because of one of those would be worse than the jump it
     - replaced. -->
    <div v-if="showSkeletons" class="playlists-view__grid">
      <tile-skeleton v-for="n in SKELETON_TILES" :key="n" />
    </div>

    <template v-if="personalPlaylists.length">
      <h2 class="section-title">{{ $t('playlists.personal') }}</h2>
      <div class="playlists-view__grid">
        <playlist-tile
          v-for="playlist in personalPlaylists"
          :key="playlist.id"
          :playlist="playlist"
          @play="playPlaylist"
          @play-next="queuePlaylist($event, 'next')"
          @add-to-queue="queuePlaylist($event, 'end')"
          @rename="openRename"
          @delete="openDelete"
        />
      </div>
    </template>

    <template v-if="globalPlaylists.length">
      <h2 class="section-title">{{ $t('playlists.global') }}</h2>
      <div class="playlists-view__grid">
        <playlist-tile
          v-for="playlist in globalPlaylists"
          :key="playlist.id"
          :playlist="playlist"
          show-owner
          @play="playPlaylist"
          @play-next="queuePlaylist($event, 'next')"
          @add-to-queue="queuePlaylist($event, 'end')"
        />
      </div>
    </template>

    <v-alert
      v-if="!libraryStore.loading && !personalPlaylists.length && !globalPlaylists.length"
      type="info"
      variant="tonal"
    >
      {{
        filterQuery
          ? $t('playlists.noPlaylistsForQuery', { query: filterQuery })
          : $t('playlists.noPlaylistsYet')
      }}
    </v-alert>

    <playlist-edit-dialog ref="editDialog" />
    <playlist-delete-dialog ref="deleteDialog" />

    <v-dialog v-model="createDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('playlists.createTitle') }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="newPlaylistName"
            :label="$t('common.name')"
            variant="solo-filled"
            clearable
            @keyup.enter="createPlaylist"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="createDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" @click="createPlaylist">{{ $t('common.create') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import { usePlaybackStore } from '@/stores/playback'
import { matchesAllTerms } from '@/services/textSearch'
import DetailHeader from '@/components/library/DetailHeader.vue'
import PlaylistTile from '@/components/library/PlaylistTile.vue'
import TileSkeleton from '@/components/library/TileSkeleton.vue'
import PlaylistEditDialog from '@/components/library/PlaylistEditDialog.vue'
import PlaylistDeleteDialog from '@/components/library/PlaylistDeleteDialog.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import type { Playlist } from '@/types/library'

// Enough placeholder tiles to read as a grid rather than as one stray box.
// No real count to key off yet — the list they stand in for is exactly what
// hasn't arrived — so this is a plain number, unlike the shelves, which
// measure how many fit across (see cardRowFit.ts) because theirs scroll.
const SKELETON_TILES = 8

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'PlaylistsView',
  components: {
    DetailHeader,
    PlaylistTile,
    TileSkeleton,
    PlaylistEditDialog,
    PlaylistDeleteDialog,
    StickyFilter,
  },
  data() {
    return {
      SKELETON_TILES,
      createDialog: false,
      newPlaylistName: '',
      filterQuery: '',
      // filteredPlaylists reads this instead of filterQuery directly, so
      // filtering doesn't run synchronously on every keystroke — see the
      // identical pattern (and its rationale) in SongsView.vue.
      debouncedQuery: '',
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    authStore() {
      return useAuthStore()
    },
    showSkeletons(): boolean {
      return this.libraryStore.loading && this.libraryStore.playlists.length === 0
    },
    filteredPlaylists(): Playlist[] {
      const query = this.debouncedQuery
      if (!query.trim()) return this.libraryStore.playlists
      return this.libraryStore.playlists.filter((playlist: Playlist) =>
        matchesAllTerms(query, playlist.name),
      )
    },
    // Own playlists first, everything else (public playlists shared by
    // other users) below in its own section.
    personalPlaylists(): Playlist[] {
      return this.filteredPlaylists.filter((p) => p.owner === this.authStore.username)
    },
    globalPlaylists(): Playlist[] {
      return this.filteredPlaylists.filter((p) => p.owner !== this.authStore.username)
    },
  },
  watch: {
    filterQuery(value: string | null) {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
      }, 200)
    },
  },
  created() {
    this.libraryStore.fetchPlaylists()
  },
  methods: {
    async playPlaylist(playlist: Playlist) {
      // getPlaylists.view (the list this view renders) doesn't include each
      // playlist's songs — only getPlaylist.view for a single id does —
      // so the full song list has to be fetched before it can be queued.
      const full = await this.libraryStore.fetchPlaylist(playlist.id)
      // pinFirst: false — see PlaylistDetailView.vue's identical comment.
      // peek: replaces the queue with more than one song — see
      // peekQueueDrawer()'s own comment for the rule.
      await usePlaybackStore().playSongList(full.songs, 0, false, full.songs.length > 1)
    },
    /** Queueing a playlist needs its songs, which the list this view
     * renders doesn't carry — same fetch playPlaylist() above makes. */
    async queuePlaylist(playlist: Playlist, where: 'next' | 'end') {
      const playback = usePlaybackStore()
      try {
        const full = await this.libraryStore.fetchPlaylist(playlist.id)
        if (!full.songs.length) return
        if (where === 'next') playback.queueNext(full.songs)
        else playback.addToQueue(full.songs)
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: playlist.name,
          message: this.$t('library.songsUnavailable'),
        })
        console.error('[playlists] Failed to load playlist songs:', error)
      }
    },
    openRename(playlist: Playlist) {
      ;(this.$refs.editDialog as { open: (playlist: Playlist) => void } | undefined)?.open(playlist)
    },
    openDelete(playlist: Playlist) {
      ;(this.$refs.deleteDialog as { open: (playlist: Playlist) => void } | undefined)?.open(
        playlist,
      )
    },
    async createPlaylist() {
      if (!this.newPlaylistName.trim()) return
      await this.libraryStore.createPlaylist(this.newPlaylistName)
      this.newPlaylistName = ''
      this.createDialog = false
    },
  },
}
</script>

<style scoped>
/* Same wrapping-tile-grid rhythm as RadioView.vue's own .radio-view__grid
 * — one shared "grid of bordered tiles" look for both, in place of the
 * plain single-column list this used to be. */
.playlists-view__grid {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}

/* A heading sits close to the grid it names; the grids themselves are
 * further apart, so "Personal" and "Shared" read as two blocks. */
.section-title {
  margin-bottom: 8px;
}

.playlists-view__grid {
  margin-bottom: 24px;
}
</style>
