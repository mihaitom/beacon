<template>
  <div
    class="album-card"
    @click="!playOnClick && $router.push(`/albums/${album.id}`)"
    @contextmenu.prevent="openMenu"
  >
    <div class="album-card-cover" @click="playOnClick && onCoverClick()">
      <cover-art :cover-art-id="album.coverArtId" :size="160" />
      <!-- Only the cover plays on click (see playOnClick) — this visual
       - affordance is what tells you that, instead of it being a silent
       - behavior change from every other album card in the app. -->
      <div v-if="playOnClick" class="album-card-play-overlay">
        <v-icon icon="mdi-play-circle" size="40" />
      </div>
      <v-btn
        v-if="authStore.capabilities.favorites"
        :icon="album.starred ? 'mdi-heart' : 'mdi-heart-outline'"
        :color="album.starred ? 'primary' : undefined"
        size="small"
        variant="flat"
        class="album-card-star"
        :class="{ 'album-card-star--visible': album.starred }"
        :title="$t(album.starred ? 'library.unstar' : 'library.star')"
        @click.stop="toggleStar"
      />
    </div>
    <!-- Title stays a real link to the album page in playOnClick mode —
     - the cover took over "click to play", so this is still how you reach
     - the album itself (browsing), same destination the whole card used to
     - go to. -->
    <router-link
      v-if="playOnClick"
      :to="`/albums/${album.id}`"
      class="album-card-title text-body-medium mt-2 text-truncate"
      @click.stop
    >
      {{ album.name }}
    </router-link>
    <div v-else class="album-card-title text-body-medium mt-2 text-truncate">{{ album.name }}</div>
    <router-link
      :to="`/artists/${album.artistId}`"
      class="album-card-artist text-body-small text-medium-emphasis text-truncate"
      @click.stop
    >
      {{ album.artist }}
    </router-link>
    <!-- Right-click, not a click: the card's own click is already how you
     - open (or play) the album. Every entry here acts on the album's whole
     - track list, which is fetched on demand (see withSongs) — a grid of
     - fifty cards must not fetch fifty track lists to render. -->
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
         - up a long list — see docs/styleguide.md's context-menu section
         - for the four the app uses and what belongs in each. -->
      <context-menu-section :label="$t('library.menuLibrary')" />
      <add-to-playlist-submenu @create="createPlaylist" @select="addToPlaylist" />
      <context-menu-section :label="$t('library.menuNavigation')" />
      <v-list-item v-if="album.artistId" :to="`/artists/${album.artistId}`">
        <template #prepend><v-icon icon="mdi-account-music" size="small" /></template>
        <v-list-item-title>{{ $t('library.goToArtist') }}</v-list-item-title>
      </v-list-item>
      <context-menu-section :label="$t('library.menuDetails')" />
      <v-list-item v-if="album.coverArtId" @click="showArtwork">
        <template #prepend><v-icon icon="mdi-image-outline" size="small" /></template>
        <v-list-item-title>{{ $t('library.showArtwork') }}</v-list-item-title>
      </v-list-item>
    </tile-context-menu>
    <create-playlist-dialog ref="createDialog" />
  </div>
</template>

<script lang="ts">
import CoverArt from './CoverArt.vue'
import TileContextMenu from './TileContextMenu.vue'
import ContextMenuSection from './ContextMenuSection.vue'
import AddToPlaylistSubmenu from './AddToPlaylistSubmenu.vue'
import CreatePlaylistDialog from './CreatePlaylistDialog.vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { emitter } from '@/emitter'
import type { Album, Song } from '@/types/library'

export default {
  name: 'AlbumCard',
  components: {
    CoverArt,
    TileContextMenu,
    ContextMenuSection,
    AddToPlaylistSubmenu,
    CreatePlaylistDialog,
  },
  props: {
    album: {
      type: Object as () => Album,
      required: true,
    },
    // Opt-in, not the default — every other place this card appears
    // (AlbumsView.vue, ArtistDetailView.vue, GenreDetailView.vue, ...) is a
    // browse context where clicking an album card is expected to open it,
    // same as clicking any other library row. HomeView.vue's shelves are
    // the one place clicking an *album you'd actually want to listen to
    // right now* makes more sense as "play this" — see its own comment.
    playOnClick: {
      type: Boolean,
      default: false,
    },
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
  },
  methods: {
    /** $refs is deliberately read here rather than in a computed: it is
     * not reactive, so a computed would cache the `undefined` it saw before
     * the menu was ever mounted and never look again. */
    openMenu(event: MouseEvent): void {
      const menu = this.$refs.menu as { open: (event: MouseEvent) => void } | undefined
      menu?.open(event)
      // Eagerly, not when the submenu is hovered — the playlist list should
      // already be there by the time it is, and playlist counts are small.
      // Same reasoning as SongRow.vue's own openMenu().
      if (useLibraryStore().playlists.length === 0) {
        void useLibraryStore().fetchPlaylists()
      }
    },
    /** The album's tracks, fetched the first time something needs them.
     * Album cards come from listing endpoints, which carry no track list —
     * every menu action below is what actually asks for one. */
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
        console.error('[album-card] Failed to load album songs:', error)
        return null
      }
    },
    async play(): Promise<void> {
      const songs = await this.withSongs()
      // pinFirst: false, peek — the same call onCoverClick() makes, see its
      // own comment.
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
    async onCoverClick() {
      const full = await useLibraryStore().fetchAlbum(this.album.id)
      // pinFirst: false — see PlaylistDetailView.vue's identical comment.
      // peek: replaces the queue with more than one song — see
      // peekQueueDrawer()'s own comment for the rule.
      await usePlaybackStore().playSongList(full.songs, 0, false, full.songs.length > 1)
    },
    async toggleStar() {
      await useLibraryStore().toggleStar({ albumId: this.album.id, starred: this.album.starred })
      // Prop mutation is intentional here — the store's own toggleStar()
      // updates a separate favorites-list slice, not this album's own
      // `starred` field (returned per-item by getAlbumList2.view), so this
      // is the only place that can give immediate optimistic UI feedback —
      // same "caller owns optimistic local state" pattern library.ts's
      // setRating() documents.
      // eslint-disable-next-line vue/no-mutating-props
      this.album.starred = !this.album.starred
    },
  },
}
</script>

<style scoped>
.album-card {
  width: 160px;
  cursor: pointer;
}

.album-card-cover {
  position: relative;
  border-radius: 4px;
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.album-card:hover .album-card-cover {
  transform: translateY(-3px);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
}

.album-card-play-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  background: rgba(11, 13, 19, 0.35);
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
}

.album-card:hover .album-card-play-overlay {
  opacity: 1;
}

.album-card-star {
  position: absolute;
  top: 6px;
  right: 6px;
  opacity: 0;
  background: rgba(11, 13, 19, 0.75) !important;
  transition: opacity 0.15s ease;
}

.album-card:hover .album-card-star {
  opacity: 1;
}

/* See ArtistCard.vue's identical rule — amber only for an actually
 * starred album, not merely a hovered one. */
.album-card-star--visible {
  opacity: 1;
  color: rgb(var(--v-theme-primary)) !important;
  background: transparent !important;
}

.album-card:hover .album-card-title {
  color: rgb(var(--v-theme-primary));
}

/* Only actually needed once .album-card-title is a router-link (playOnClick
 * mode) — a plain <div> (the non-playOnClick case) never needed a color/
 * decoration reset or a display override, it's already block. Harmless to
 * apply unconditionally either way. */
.album-card-title {
  display: block;
  color: inherit;
  text-decoration: none;
}

.album-card-artist {
  /* text-truncate (Vuetify's utility class, applied inline above) needs a
   * block-level box with a bounded width to actually ellipsize against —
   * an <a>'s default `inline` display doesn't respect that. */
  display: block;
  text-decoration: none;
  width: fit-content;
  max-width: 100%;
}

.album-card-artist:hover {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
}
</style>
