<template>
  <!-- An album's right-click menu, for its card and anywhere else an album
   - stands as one line (the Stats charts). The host calls open() from its
   - own @contextmenu. Every entry acts on the album's whole track list,
   - which is fetched on demand (see withSongs) - a grid of fifty cards must
   - not fetch fifty track lists to render. -->
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
    <!-- Each heading below names a kind of action rather than breaking
       - up a long list - see docs/styleguide.md's context-menu section
       - for the four the app uses and what belongs in each. -->
    <context-menu-section :label="$t('library.menuLibrary')" />
    <rating-item :item="album" />
    <add-to-playlist-submenu @create="createPlaylist" @select="addToPlaylist" />
    <context-menu-section :label="$t('library.menuNavigation')" />
    <v-list-item v-if="goToAlbum" :to="`/albums/${album.id}`">
      <template #prepend><v-icon icon="mdi-album" size="small" /></template>
      <v-list-item-title>{{ $t('library.goToAlbum') }}</v-list-item-title>
    </v-list-item>
    <v-list-item v-if="album.artistId" :to="`/artists/${album.artistId}`">
      <template #prepend><v-icon icon="mdi-account-music" size="small" /></template>
      <v-list-item-title>{{ $t('library.goToArtist') }}</v-list-item-title>
    </v-list-item>
    <!-- Artwork is the section's only entry, so without it the heading
       - would stand over nothing. -->
    <template v-if="album.coverArtId">
      <context-menu-section :label="$t('library.menuDetails')" />
      <v-list-item @click="showArtwork">
        <template #prepend><v-icon icon="mdi-image-outline" size="small" /></template>
        <v-list-item-title>{{ $t('library.showArtwork') }}</v-list-item-title>
      </v-list-item>
    </template>
  </tile-context-menu>
  <create-playlist-dialog ref="createDialog" />
</template>

<script lang="ts">
import type { PropType } from 'vue'
import TileContextMenu from './TileContextMenu.vue'
import ContextMenuSection from './ContextMenuSection.vue'
import AddToPlaylistSubmenu from './AddToPlaylistSubmenu.vue'
import RatingItem from './RatingItem.vue'
import CreatePlaylistDialog from './CreatePlaylistDialog.vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { emitter } from '@/emitter'
import type { Album, Song } from '@/types/library'

export default {
  name: 'AlbumContextMenu',
  components: {
    TileContextMenu,
    ContextMenuSection,
    AddToPlaylistSubmenu,
    RatingItem,
    CreatePlaylistDialog,
  },
  props: {
    album: { type: Object as PropType<Album>, required: true },
    /** Off on the album's own card, whose click already goes there. */
    goToAlbum: { type: Boolean, default: false },
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
    /** The album's tracks, fetched the first time something needs them:
     * listing endpoints carry no track list. */
    async withSongs(): Promise<Song[] | null> {
      try {
        const full = await useLibraryStore().fetchAlbum(this.album.id)
        return full.songs
      } catch (error) {
        emitter.emit('toast', {
          level: 'error',
          title: this.album.name,
          message: this.$t('library.songsUnavailable'),
        })
        console.error('[album-menu] Failed to load album songs:', error)
        return null
      }
    },
    async play(): Promise<void> {
      const songs = await this.withSongs()
      // pinFirst: false, peek - the same call AlbumCard's cover click makes.
      if (songs) await usePlaybackStore().playSongList(songs, 0, false, songs.length > 1)
    },
    async playNext(): Promise<void> {
      const songs = await this.withSongs()
      if (songs) usePlaybackStore().queueNext(songs)
    },
    async addToQueue(): Promise<void> {
      const songs = await this.withSongs()
      if (songs) usePlaybackStore().addToQueue(songs)
    },
    async addToPlaylist(playlistId: string): Promise<void> {
      const songs = await this.withSongs()
      if (!songs) return
      await useLibraryStore().addToPlaylist(
        playlistId,
        songs.map((song) => song.id),
      )
    },
    async createPlaylist(): Promise<void> {
      const songs = await this.withSongs()
      if (!songs) return
      const dialog = this.$refs.createDialog as { open: (ids: string[]) => void } | undefined
      dialog?.open(songs.map((song) => song.id))
    },
    showArtwork(): void {
      emitter.emit('showArtwork', {
        coverArtId: this.album.coverArtId,
        title: this.album.name,
        subtitle: this.album.artist,
      })
    },
  },
}
</script>
