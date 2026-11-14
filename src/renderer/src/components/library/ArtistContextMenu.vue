<template>
  <!-- An artist's right-click menu, for its card and anywhere else an
   - artist stands as one line (the Stats charts). The host calls open()
   - from its own @contextmenu. Playing anything needs the artist's tracks,
   - which a listing endpoint doesn't carry - fetched on demand, see
   - withSongs(). -->
  <tile-context-menu ref="menu">
    <!-- Now, next, at the end - then Artist Radio, which conjures a
       - queue instead of adding to the one there is. Same section order
       - as every other menu in the app; see docs/styleguide.md. -->
    <context-menu-section :label="$t('library.menuPlayback')" />
    <v-list-item @click="play">
      <template #prepend><v-icon icon="mdi-play" size="small" /></template>
      <v-list-item-title>{{ $t('library.playAll') }}</v-list-item-title>
    </v-list-item>
    <v-list-item @click="playNext">
      <template #prepend><v-icon icon="mdi-skip-next-outline" size="small" /></template>
      <v-list-item-title>{{ $t('library.playNext') }}</v-list-item-title>
    </v-list-item>
    <v-list-item @click="addToQueue">
      <template #prepend><v-icon icon="mdi-playlist-plus" size="small" /></template>
      <v-list-item-title>{{ $t('common.addToQueue') }}</v-list-item-title>
    </v-list-item>
    <v-list-item v-if="authStore.capabilities.songRadio" @click="startArtistRadio">
      <template #prepend><v-icon icon="mdi-radio-tower" size="small" /></template>
      <v-list-item-title>{{ $t('library.artistRadio') }}</v-list-item-title>
    </v-list-item>
    <template v-if="goToArtist">
      <context-menu-section :label="$t('library.menuNavigation')" />
      <v-list-item :to="`/artists/${artist.id}`">
        <template #prepend><v-icon icon="mdi-account-music" size="small" /></template>
        <v-list-item-title>{{ $t('library.goToArtist') }}</v-list-item-title>
      </v-list-item>
    </template>
    <!-- Artwork is the section's only entry, so without it the heading
       - would stand over nothing. -->
    <template v-if="hasArtwork">
      <context-menu-section :label="$t('library.menuDetails')" />
      <v-list-item @click="showArtwork">
        <template #prepend><v-icon icon="mdi-image-outline" size="small" /></template>
        <v-list-item-title>{{ $t('library.showArtwork') }}</v-list-item-title>
      </v-list-item>
    </template>
  </tile-context-menu>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import TileContextMenu from './TileContextMenu.vue'
import ContextMenuSection from './ContextMenuSection.vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { emitter } from '@/emitter'
import type { Artist, Song } from '@/types/library'

export default {
  name: 'ArtistContextMenu',
  components: { TileContextMenu, ContextMenuSection },
  props: {
    artist: { type: Object as PropType<Artist>, required: true },
    /** Off on the artist's own card, whose click already goes there. */
    goToArtist: { type: Boolean, default: false },
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    hasArtwork(): boolean {
      return Boolean(this.artist.coverArtId || this.artist.imageUrl)
    },
  },
  methods: {
    open(event: MouseEvent): void {
      const menu = this.$refs.menu as { open: (event: MouseEvent) => void } | undefined
      menu?.open(event)
    },
    /** Everything the artist has, in the order the library hands it back -
     * the same list ArtistDetailView's own song table shows. */
    async withSongs(): Promise<Song[] | null> {
      try {
        return await useLibraryStore().fetchAllSongsForArtist(this.artist)
      } catch (error) {
        emitter.emit('toast', {
          level: 'error',
          title: this.artist.name,
          message: this.$t('library.songsUnavailable'),
        })
        console.error('[artist-menu] Failed to load artist songs:', error)
        return null
      }
    },
    async play(): Promise<void> {
      const songs = await this.withSongs()
      if (songs?.length) await usePlaybackStore().playSongList(songs, 0, false, true)
    },
    async playNext(): Promise<void> {
      const songs = await this.withSongs()
      if (songs?.length) usePlaybackStore().queueNext(songs)
    },
    async addToQueue(): Promise<void> {
      const songs = await this.withSongs()
      if (songs?.length) usePlaybackStore().addToQueue(songs)
    },
    /** The same mix the artist page's own button starts - a server-picked
     * selection across the catalog, not the discography in order. */
    async startArtistRadio(): Promise<void> {
      try {
        await usePlaybackStore().startArtistRadio(this.artist)
      } catch (error) {
        emitter.emit('toast', {
          level: 'error',
          title: this.$t('library.artistRadio'),
          message: this.$t('library.artistRadioError'),
        })
        console.error('[artist-menu] Failed to start artist radio:', error)
      }
    },
    showArtwork(): void {
      emitter.emit('showArtwork', {
        coverArtId: this.artist.coverArtId,
        imageUrl: this.artist.imageUrl,
        title: this.artist.name,
        // Artists are circles everywhere else in the app; a photo squared
        // off only in the viewer would read as a different picture.
        rounded: true,
        fallbackIcon: 'mdi-account-music',
      })
    },
  },
}
</script>
