<template>
  <v-menu submenu>
    <template #activator="{ props: submenuProps }">
      <v-list-item v-bind="submenuProps">
        <template #prepend><v-icon icon="mdi-playlist-music" size="small" /></template>
        <v-list-item-title>{{ $t('common.addToPlaylistMenu') }}</v-list-item-title>
        <template #append><v-icon icon="mdi-menu-right" size="small" /></template>
      </v-list-item>
    </template>
    <v-list density="compact" class="playlist-submenu">
      <v-list-item @click="$emit('create')">
        <template #prepend><v-icon icon="mdi-plus" size="small" /></template>
        <v-list-item-title>{{ $t('common.createNewPlaylist') }}</v-list-item-title>
      </v-list-item>
      <template v-if="libraryStore.playlists.length">
        <v-divider />
        <v-list-item
          v-for="playlist in libraryStore.playlists"
          :key="playlist.id"
          @click="$emit('select', playlist.id)"
        >
          <v-list-item-title>{{ playlist.name }}</v-list-item-title>
        </v-list-item>
      </template>
    </v-list>
  </v-menu>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'

/**
 * The "Add to playlist" entry and its submenu of existing playlists —
 * shared by everything that can be added to one (a song row, an album
 * tile). Deliberately says nothing about *what* is being added: it reports
 * which playlist was picked (`select`) or that a new one is wanted
 * (`create`), and the caller, which is the only one that knows whether that
 * means one song, a whole selection or an album, does the adding.
 */
export default {
  name: 'AddToPlaylistSubmenu',
  emits: ['create', 'select'],
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
  },
}
</script>

<style scoped>
/* A long playlist list would otherwise run off the bottom of the screen. */
.playlist-submenu {
  max-height: 320px;
  overflow-y: auto;
}
</style>
