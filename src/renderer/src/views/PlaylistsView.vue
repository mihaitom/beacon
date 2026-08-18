<template>
  <v-container fluid>
    <detail-header fallback-icon="mdi-playlist-music" :title="$t('playlists.title')">
      <template v-if="authStore.capabilities.emptyPlaylistCreation" #actions>
        <v-btn prepend-icon="mdi-plus" variant="tonal" @click="createDialog = true">{{
          $t('playlists.newPlaylist')
        }}</v-btn>
      </template>
    </detail-header>

    <sticky-filter>
      <v-text-field
        v-model="filterQuery"
        :label="$t('common.filter')"
        prepend-inner-icon="mdi-filter-variant"
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
      <div class="playlist-list mb-6">
        <playlist-row
          v-for="playlist in personalPlaylists"
          :key="playlist.id"
          :playlist="playlist"
          @play="playPlaylist"
        />
      </div>
    </template>

    <template v-if="globalPlaylists.length">
      <h2 class="section-title mb-2">{{ $t('playlists.global') }}</h2>
      <div class="playlist-list">
        <playlist-row
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
import DetailHeader from '@/components/library/DetailHeader.vue'
import PlaylistRow from '@/components/library/PlaylistRow.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import type { Playlist } from '@/types/library'

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'PlaylistsView',
  components: { DetailHeader, PlaylistRow, StickyFilter },
  data() {
    return {
      createDialog: false,
      newPlaylistName: '',
      filterQuery: '',
      // filteredPlaylists reads this instead of filterQuery directly, so
      // filtering doesn't run synchronously on every keystroke — see the
      // identical pattern (and its rationale) in TracksView.vue.
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
      const query = this.debouncedQuery.trim().toLowerCase()
      if (!query) return this.libraryStore.playlists
      return this.libraryStore.playlists.filter((playlist: Playlist) =>
        playlist.name.toLowerCase().includes(query),
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
      // playlist's tracks — only getPlaylist.view for a single id does —
      // so the full track list has to be fetched before it can be queued.
      const full = await this.libraryStore.fetchPlaylist(playlist.id)
      await usePlaybackStore().playTrackList(full.tracks, 0)
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
.playlist-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
