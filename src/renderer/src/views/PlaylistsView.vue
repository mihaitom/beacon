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
        class="mb-4"
        style="max-width: 320px"
      />
    </sticky-filter>
    <v-alert v-if="libraryStore.error" type="error" variant="tonal" class="mb-4">
      {{ libraryStore.error }}
    </v-alert>
    <v-progress-circular v-if="libraryStore.loading" indeterminate class="mb-4" />

    <template v-if="personalPlaylists.length">
      <h2 class="section-title mb-2">{{ $t('playlists.personal') }}</h2>
      <div class="playlists-view__grid mb-6">
        <playlist-tile
          v-for="playlist in personalPlaylists"
          :key="playlist.id"
          :playlist="playlist"
          @play="playPlaylist"
        />
      </div>
    </template>

    <template v-if="globalPlaylists.length">
      <h2 class="section-title mb-2">{{ $t('playlists.global') }}</h2>
      <div class="playlists-view__grid">
        <playlist-tile
          v-for="playlist in globalPlaylists"
          :key="playlist.id"
          :playlist="playlist"
          show-owner
          @play="playPlaylist"
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
import StickyFilter from '@/components/StickyFilter.vue'
import type { Playlist } from '@/types/library'

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'PlaylistsView',
  components: { DetailHeader, PlaylistTile, StickyFilter },
  data() {
    return {
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
</style>
