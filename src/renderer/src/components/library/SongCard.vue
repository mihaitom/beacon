<template>
  <!-- AlbumCard.vue's shape for a single song: the cover plays it, the two
   - lines below lead to its album and artist. The song's own title links to
   - the album because a song has no page of its own. -->
  <div class="song-card" @contextmenu.prevent="openMenu">
    <div class="song-card-cover" @click="play">
      <cover-art :cover-art-id="song.coverArtId" :size="160" />
      <div class="song-card-play-overlay">
        <v-icon icon="mdi-play-circle" size="40" />
      </div>
      <v-btn
        v-if="authStore.capabilities.favorites"
        :icon="song.starred ? 'mdi-heart' : 'mdi-heart-outline'"
        :color="song.starred ? 'primary' : undefined"
        size="small"
        variant="flat"
        class="song-card-star"
        :class="{ 'song-card-star--visible': song.starred }"
        :title="$t(song.starred ? 'library.unstar' : 'library.star')"
        @click.stop="toggleStar"
      />
    </div>
    <router-link
      v-if="song.albumId"
      :to="`/albums/${song.albumId}`"
      class="song-card-title text-body-medium"
    >
      {{ song.title }}
    </router-link>
    <div v-else class="song-card-title text-body-medium">{{ song.title }}</div>
    <router-link
      v-if="song.artistId"
      :to="`/artists/${song.artistId}`"
      class="song-card-artist text-body-small text-medium-emphasis"
    >
      {{ song.artist }}
    </router-link>
    <div v-else class="song-card-artist text-body-small text-medium-emphasis">
      {{ song.artist }}
    </div>
    <!-- SongRow.vue's menu for one song, minus what only a table has
     - (selection, removing from a playlist). -->
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
      <add-to-playlist-submenu @create="createPlaylist" @select="addToPlaylist" />
      <context-menu-section :label="$t('library.menuNavigation')" />
      <v-list-item v-if="song.albumId" :to="`/albums/${song.albumId}`">
        <template #prepend><v-icon icon="mdi-album" size="small" /></template>
        <v-list-item-title>{{ $t('library.goToAlbum') }}</v-list-item-title>
      </v-list-item>
      <v-list-item v-if="song.artistId" :to="`/artists/${song.artistId}`">
        <template #prepend><v-icon icon="mdi-account-music" size="small" /></template>
        <v-list-item-title>{{ $t('library.goToArtist') }}</v-list-item-title>
      </v-list-item>
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
import type { Song } from '@/types/library'

export default {
  name: 'SongCard',
  components: {
    CoverArt,
    TileContextMenu,
    ContextMenuSection,
    AddToPlaylistSubmenu,
    CreatePlaylistDialog,
  },
  props: {
    song: {
      type: Object as () => Song,
      required: true,
    },
  },
  data() {
    return {
      starring: false,
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
  },
  methods: {
    openMenu(event: MouseEvent): void {
      const menu = this.$refs.menu as { open: (event: MouseEvent) => void } | undefined
      menu?.open(event)
      // Same eager warm-up as SongRow.vue's openMenu().
      if (useLibraryStore().playlists.length === 0) {
        void useLibraryStore().fetchPlaylists()
      }
    },
    /** Just this song, the way a row in Home's top songs plays: the shelf
     * as a whole is what its own play button is for. */
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
    async toggleStar(): Promise<void> {
      if (this.starring) return
      this.starring = true
      const wasStarred = this.song.starred
      try {
        await useLibraryStore().toggleStar({ id: this.song.id, starred: wasStarred })
        // Same optimistic write SongTable.vue's own toggleStar() makes on
        // the song it was handed.
        // eslint-disable-next-line vue/no-mutating-props
        this.song.starred = !wasStarred
      } finally {
        this.starring = false
      }
    },
  },
}
</script>

<style scoped>
/* AlbumCard.vue's card, rule for rule, so the two sit in the same kind of
 * row without looking like relatives. */
.song-card {
  width: 160px;
}

.song-card-cover {
  position: relative;
  border-radius: 4px;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.song-card:hover .song-card-cover {
  transform: translateY(-3px);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
}

.song-card-play-overlay {
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

.song-card:hover .song-card-play-overlay {
  opacity: 1;
}

.song-card-star {
  position: absolute;
  top: 6px;
  right: 6px;
  opacity: 0;
  background: rgba(11, 13, 19, 0.75) !important;
  transition: opacity 0.15s ease;
}

.song-card:hover .song-card-star {
  opacity: 1;
}

/* See AlbumCard.vue's identical rule. */
@media (hover: none) {
  .song-card-star,
  .song-card-play-overlay {
    opacity: 1;
  }
}

.song-card-star--visible {
  opacity: 1;
  color: rgb(var(--v-theme-primary)) !important;
  background: transparent !important;
}

.song-card-title {
  display: block;
  margin-top: 8px;
  color: inherit;
  text-decoration: none;
}

.song-card:hover .song-card-title {
  color: rgb(var(--v-theme-primary));
}

.song-card-artist {
  display: block;
  width: fit-content;
  max-width: 100%;
  text-decoration: none;
}

a.song-card-artist:hover {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
}

.song-card-title,
.song-card-artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
