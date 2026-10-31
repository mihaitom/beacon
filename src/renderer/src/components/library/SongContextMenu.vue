<template>
  <!-- SongRow.vue's menu for one song, minus what only a table has
   - (selection, removing from a playlist). The host calls open() from its
   - own @contextmenu. -->
  <tile-context-menu ref="menu">
    <context-menu-section :label="$t('library.menuPlayback')" />
    <v-list-item @click="play">
      <template #prepend><v-icon icon="mdi-play" size="small" /></template>
      <v-list-item-title>{{ $t('library.play') }}</v-list-item-title>
    </v-list-item>
    <v-list-item @click="playNext">
      <template #prepend><v-icon icon="mdi-skip-next-outline" size="small" /></template>
      <v-list-item-title>{{ $t('library.playNext') }}</v-list-item-title>
    </v-list-item>
    <v-list-item @click="addToQueue">
      <template #prepend><v-icon icon="mdi-playlist-plus" size="small" /></template>
      <v-list-item-title>{{ $t('common.addToQueue') }}</v-list-item-title>
    </v-list-item>
    <v-list-item v-if="authStore.capabilities.songRadio" @click="startSongRadio">
      <template #prepend><v-icon icon="mdi-radio-tower" size="small" /></template>
      <v-list-item-title>{{ $t('library.songRadio') }}</v-list-item-title>
    </v-list-item>
    <context-menu-section :label="$t('library.menuLibrary')" />
    <rating-item :item="song" />
    <add-to-playlist-submenu @create="createPlaylist" @select="addToPlaylist" />
    <context-menu-section :label="$t('library.menuNavigation')" />
    <v-list-item v-if="song.albumId" :to="`/albums/${song.albumId}`">
      <template #prepend><v-icon icon="mdi-album" size="small" /></template>
      <v-list-item-title>{{ $t('library.goToAlbum') }}</v-list-item-title>
    </v-list-item>
    <go-to-artist-items :credit="song.artist" :artist-id="song.artistId" />
    <context-menu-section :label="$t('library.menuDetails')" />
    <v-list-item v-if="song.coverArtId" @click="showArtwork">
      <template #prepend><v-icon icon="mdi-image-outline" size="small" /></template>
      <v-list-item-title>{{ $t('library.showArtwork') }}</v-list-item-title>
    </v-list-item>
    <v-list-item @click="showInfo">
      <template #prepend><v-icon icon="mdi-information-outline" size="small" /></template>
      <v-list-item-title>{{ $t('library.songInfo') }}</v-list-item-title>
    </v-list-item>
  </tile-context-menu>
  <create-playlist-dialog ref="createDialog" />
</template>

<script lang="ts">
import type { PropType } from 'vue'
import GoToArtistItems from './GoToArtistItems.vue'
import TileContextMenu from './TileContextMenu.vue'
import ContextMenuSection from './ContextMenuSection.vue'
import AddToPlaylistSubmenu from './AddToPlaylistSubmenu.vue'
import RatingItem from './RatingItem.vue'
import CreatePlaylistDialog from './CreatePlaylistDialog.vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { emitter } from '@/emitter'
import type { Song } from '@/types/library'

export default {
  name: 'SongContextMenu',
  components: {
    GoToArtistItems,
    TileContextMenu,
    ContextMenuSection,
    AddToPlaylistSubmenu,
    RatingItem,
    CreatePlaylistDialog,
  },
  props: {
    song: { type: Object as PropType<Song>, required: true },
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
  },
  methods: {
    open(event: MouseEvent): void {
      const menu = this.$refs.menu as { open: (event: MouseEvent) => void } | undefined
      menu?.open(event)
      // Same eager warm-up as SongRow.vue's openMenu().
      if (useLibraryStore().playlists.length === 0) {
        void useLibraryStore().fetchPlaylists()
      }
    },
    /** Just this song: a lone song outside a table is not a queue anybody
     * meant. */
    play(): void {
      void usePlaybackStore().playSongList([this.song], 0)
    },
    playNext(): void {
      usePlaybackStore().queueNext([this.song])
    },
    addToQueue(): void {
      usePlaybackStore().addToQueue([this.song])
    },
    async startSongRadio(): Promise<void> {
      try {
        await usePlaybackStore().startSongRadio(this.song)
      } catch (error) {
        emitter.emit('toast', {
          level: 'error',
          title: this.$t('library.songRadio'),
          message: this.$t('library.songRadioError'),
        })
        console.error('[song-radio]', error)
      }
    },
    async addToPlaylist(playlistId: string): Promise<void> {
      await useLibraryStore().addToPlaylist(playlistId, [this.song.id])
    },
    createPlaylist(): void {
      const dialog = this.$refs.createDialog as { open: (ids: string[]) => void } | undefined
      dialog?.open([this.song.id])
    },
    showArtwork(): void {
      emitter.emit('showArtwork', {
        coverArtId: this.song.coverArtId,
        title: this.song.title,
        subtitle: this.song.album || this.song.artist,
      })
    },
    showInfo(): void {
      emitter.emit('showSongInfo', this.song)
    },
  },
}
</script>
