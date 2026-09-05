<template>
  <div
    class="artist-card"
    @click="$router.push(`/artists/${artist.id}`)"
    @contextmenu.prevent="openMenu"
  >
    <div class="artist-card-cover">
      <cover-art :cover-art-id="artist.coverArtId" :image-url="artist.imageUrl" :size="160" />
      <v-btn
        v-if="authStore.capabilities.favorites"
        :icon="artist.starred ? 'mdi-heart' : 'mdi-heart-outline'"
        :color="artist.starred ? 'primary' : undefined"
        size="small"
        variant="flat"
        class="artist-card-star"
        :class="{ 'artist-card-star--visible': artist.starred }"
        :title="$t(artist.starred ? 'library.unstar' : 'library.star')"
        @click.stop="toggleStar"
      />
    </div>
    <div class="artist-card-name text-body-medium mt-2 text-truncate">{{ artist.name }}</div>
    <div class="text-body-small text-medium-emphasis text-truncate">
      {{ artist.albumCount }}
      {{ artist.albumCount === 1 ? $t('library.album1') : $t('library.albumsN') }}
    </div>
    <!-- Right-click, not a click: the card's own click opens the artist.
     - Playing anything here needs the artist's tracks, which a listing
     - endpoint doesn't carry — fetched on demand, see withSongs(). -->
    <tile-context-menu ref="menu">
      <!-- Now, next, at the end — then Artist Radio, which conjures a
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
      <context-menu-section :label="$t('library.menuDetails')" />
      <v-list-item v-if="hasArtwork" @click="showArtwork">
        <template #prepend><v-icon icon="mdi-image-outline" size="small" /></template>
        <v-list-item-title>{{ $t('library.showArtwork') }}</v-list-item-title>
      </v-list-item>
    </tile-context-menu>
  </div>
</template>

<script lang="ts">
import CoverArt from './CoverArt.vue'
import TileContextMenu from './TileContextMenu.vue'
import ContextMenuSection from './ContextMenuSection.vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { emitter } from '@/emitter'
import type { Artist, Song } from '@/types/library'

export default {
  name: 'ArtistCard',
  components: { CoverArt, TileContextMenu, ContextMenuSection },
  props: {
    artist: {
      type: Object as () => Artist,
      required: true,
    },
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
    /** $refs is deliberately read here rather than in a computed: it is
     * not reactive, so a computed would cache the `undefined` it saw before
     * the menu was ever mounted and never look again. */
    openMenu(event: MouseEvent): void {
      const menu = this.$refs.menu as { open: (event: MouseEvent) => void } | undefined
      menu?.open(event)
    },
    /** Everything the artist has, in the order the library hands it back —
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
        console.error('[artist-card] Failed to load artist songs:', error)
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
    /** The same mix the artist page's own button starts — a server-picked
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
        console.error('[artist-card] Failed to start artist radio:', error)
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
    async toggleStar() {
      await useLibraryStore().toggleStar({ artistId: this.artist.id, starred: this.artist.starred })
      // Prop mutation is intentional here — see AlbumCard.vue's identical
      // pattern and comment.
      // eslint-disable-next-line vue/no-mutating-props
      this.artist.starred = !this.artist.starred
    },
  },
}
</script>

<style scoped>
/* Same width as AlbumCard.vue's own .album-card, deliberately — the two
 * appear side by side (search results, the favorites view) and read as
 * mismatched at different sizes. The cover-art :size above matches it, so
 * both card types also come out the same height: cover + name + caption. */
.artist-card {
  width: 160px;
  cursor: pointer;
}

.artist-card-cover {
  position: relative;
  border-radius: 4px;
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.artist-card:hover .artist-card-cover {
  transform: translateY(-3px);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
}

.artist-card-star {
  position: absolute;
  top: 6px;
  right: 6px;
  opacity: 0;
  background: rgba(11, 13, 19, 0.75) !important;
  transition: opacity 0.15s ease;
}

.artist-card:hover .artist-card-star {
  opacity: 1;
}

/* Amber, on nothing — same "amber means this is on" rule the rest of the
 * app follows. Both !importants undo this element's own resting style
 * above: the dark pill behind the icon exists to keep an *unstarred* heart
 * legible over artwork, and Vuetify paints `color` onto the background for
 * a flat button, so without clearing it the button stayed dark and the
 * heart never turned amber at all. */
.artist-card-star--visible {
  opacity: 1;
  color: rgb(var(--v-theme-primary)) !important;
  background: transparent !important;
}

.artist-card:hover .artist-card-name {
  color: rgb(var(--v-theme-primary));
}
</style>
