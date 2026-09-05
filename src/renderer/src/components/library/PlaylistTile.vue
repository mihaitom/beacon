<template>
  <router-link
    :to="`/playlists/${playlist.id}`"
    class="playlist-tile"
    @contextmenu.prevent="openMenu"
  >
    <!-- Bigger than the thumbnail this list used to have, and the
     - play button now lives on top of it (revealed on hover, same dimmed-
     - backdrop + centered icon language as AlbumCard.vue's own shelf-card
     - overlay) instead of sitting off to the side next to the text. Not
     - RadioStationCard.vue's smaller favicon size, deliberately — a
     - playlist cover is real artwork worth more room than a station's tiny
     - logo, even inside the same bordered-tile shape (see .playlist-tile
     - below, same chrome as that component's own). -->
    <div class="playlist-tile__cover-wrap">
      <cover-art
        :cover-art-id="playlist.coverArtId"
        :size="88"
        fallback-icon="mdi-playlist-music"
        class="playlist-tile__cover"
      />
      <v-btn
        icon="mdi-play-circle"
        variant="text"
        size="large"
        class="playlist-tile__play-overlay"
        :title="$t('library.play')"
        @click.prevent.stop="$emit('play', playlist)"
      />
    </div>
    <div class="playlist-tile__info">
      <div class="text-body-medium playlist-tile__name">{{ playlist.name }}</div>
      <div class="text-body-small text-medium-emphasis">{{ meta }}</div>
    </div>
    <v-icon
      v-if="playlist.public"
      icon="mdi-earth"
      size="16"
      class="text-medium-emphasis playlist-tile__dot"
      :title="$t('playlists.public')"
    />
    <v-icon
      icon="mdi-chevron-right"
      size="20"
      class="playlist-tile__chevron text-medium-emphasis"
    />
    <!-- Renaming and deleting used to live on the playlist's own page only
     - — reachable from the overview solely by opening the playlist first.
     - Both are offered here for the user's own playlists; someone else's
     - shared playlist is not theirs to change. -->
    <tile-context-menu ref="menu">
      <context-menu-section :label="$t('library.menuPlayback')" />
      <v-list-item @click="$emit('play', playlist)">
        <template #prepend><v-icon icon="mdi-play" size="small" /></template>
        <v-list-item-title>{{ $t('library.play') }}</v-list-item-title>
      </v-list-item>
      <v-list-item @click="$emit('play-next', playlist)">
        <template #prepend><v-icon icon="mdi-skip-next-outline" size="small" /></template>
        <v-list-item-title>{{ $t('library.playNext') }}</v-list-item-title>
      </v-list-item>
      <v-list-item @click="$emit('add-to-queue', playlist)">
        <template #prepend><v-icon icon="mdi-playlist-plus" size="small" /></template>
        <v-list-item-title>{{ $t('common.addToQueue') }}</v-list-item-title>
      </v-list-item>
      <template v-if="isOwnPlaylist">
        <context-menu-section :label="$t('library.menuLibrary')" />
        <v-list-item @click="$emit('rename', playlist)">
          <template #prepend><v-icon icon="mdi-pencil-outline" size="small" /></template>
          <v-list-item-title>{{ $t('common.edit') }}</v-list-item-title>
        </v-list-item>
        <v-list-item @click="$emit('delete', playlist)">
          <template #prepend><v-icon icon="mdi-delete-outline" size="small" /></template>
          <v-list-item-title>{{ $t('common.delete') }}</v-list-item-title>
        </v-list-item>
      </template>
      <template v-if="playlist.coverArtId">
        <context-menu-section :label="$t('library.menuDetails')" />
        <v-list-item @click="showArtwork">
          <template #prepend><v-icon icon="mdi-image-outline" size="small" /></template>
          <v-list-item-title>{{ $t('library.showArtwork') }}</v-list-item-title>
        </v-list-item>
      </template>
    </tile-context-menu>
  </router-link>
</template>

<script lang="ts">
import CoverArt from './CoverArt.vue'
import TileContextMenu from './TileContextMenu.vue'
import ContextMenuSection from './ContextMenuSection.vue'
import { useAuthStore } from '@/stores/auth'
import { emitter } from '@/emitter'
import type { Playlist } from '@/types/library'

export default {
  name: 'PlaylistTile',
  components: { CoverArt, TileContextMenu, ContextMenuSection },
  props: {
    playlist: {
      type: Object as () => Playlist,
      required: true,
    },
    // Set for tiles in the "global playlists" section — every playlist
    // there belongs to someone else by definition (see PlaylistsView.vue's
    // globalPlaylists filter), so the owner is worth showing there but not
    // among the user's own playlists.
    showOwner: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['play', 'play-next', 'add-to-queue', 'rename', 'delete'],
  computed: {
    /** Someone else's public playlist is visible here (see showOwner) but
     * not editable — the same rule PlaylistDetailView.vue applies to its
     * own edit/delete buttons. */
    isOwnPlaylist(): boolean {
      return this.playlist.owner === useAuthStore().username
    },
    meta(): string {
      const count = this.$t('playlists.songCount', { count: this.playlist.songCount })
      const duration = this.formatDuration(this.playlist.duration)
      const parts = [count, duration].filter(Boolean)
      if (this.showOwner && this.playlist.owner) {
        parts.push(this.$t('playlists.byOwner', { owner: this.playlist.owner }) as string)
      }
      return parts.join(' · ')
    },
  },
  methods: {
    openMenu(event: MouseEvent): void {
      const menu = this.$refs.menu as { open: (event: MouseEvent) => void } | undefined
      menu?.open(event)
    },
    showArtwork(): void {
      emitter.emit('showArtwork', {
        coverArtId: this.playlist.coverArtId,
        title: this.playlist.name,
        fallbackIcon: 'mdi-playlist-music',
      })
    },
    formatDuration(seconds: number): string {
      if (!seconds) return ''
      const total = Math.round(seconds)
      const hours = Math.floor(total / 3600)
      const minutes = Math.round((total % 3600) / 60)
      if (hours > 0) return this.$t('playlists.durationHours', { hours, minutes })
      return this.$t('playlists.durationMinutes', { minutes })
    },
  },
}
</script>

<style scoped>
/* Same bordered/tinted chrome as RadioStationCard.vue's own .radio-tile
 * (and StatsView.vue's .stat-tile before that) — a horizontal box rather
 * than AlbumCard.vue/ArtistCard.vue's bare cover-plus-caption, so browsing
 * playlists and browsing radio stations read as the same kind of screen at
 * a glance instead of two unrelated list styles. */
/* 360px, not the 300 both tiles started at: these are horizontal tiles
 * whose text sits *beside* the artwork, so width is the only thing that
 * buys a longer playlist or station name before it truncates — and the
 * bigger artwork below takes some of the old width away again. Kept in
 * step with PlaylistTile.vue's own .playlist-tile, which is the same
 * chrome on the same kind of screen; changing one alone makes the two
 * grids read as unrelated. */
.playlist-tile {
  display: flex;
  align-items: center;
  width: 360px;
  padding: 10px 12px 10px 10px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--beacon-hairline);
  text-decoration: none;
  color: inherit;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}

.playlist-tile:hover {
  background: var(--beacon-hover);
}

.playlist-tile:hover .playlist-tile__chevron {
  opacity: 1;
  transform: translateX(2px);
}

.playlist-tile:hover .playlist-tile__play-overlay {
  opacity: 1;
}

.playlist-tile__cover-wrap {
  position: relative;
  flex-shrink: 0;
  margin-right: 14px;
}

.playlist-tile__cover {
  flex-shrink: 0;
}

/* Fills the cover exactly (Vuetify's own icon-button sizing is overridden
 * below) rather than floating a fixed-size circle over it — same dimmed-
 * backdrop language as AlbumCard.vue's .album-card-play-overlay, just a
 * real button here (not a decorative div) since there's no other element
 * on the cover itself to carry the click. */
.playlist-tile__play-overlay {
  position: absolute;
  inset: 0;
  width: auto;
  height: auto;
  border-radius: 4px;
  background: rgba(11, 13, 19, 0.45) !important;
  color: white;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.playlist-tile__info {
  flex: 1 1 auto;
  min-width: 0;
}

.playlist-tile__name {
  font-weight: 500;
}

.playlist-tile__chevron {
  opacity: 0;
  flex-shrink: 0;
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

/* Same breakpoint and reasoning as RadioStationCard.vue's own — see its
 * comment: below this the fixed-width tile leaves a dead gutter beside a
 * single narrow column instead of being a full-width row. */
@media (max-width: 600px) {
  .playlist-tile {
    width: 100%;
  }
}

/* Name and meta line each stay on one line under the artwork. */
.playlist-tile__info > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The separator between the two facts on the meta line. */
.playlist-tile__dot {
  margin-inline: 4px;
}

.playlist-tile__chevron {
  margin-left: 4px;
}
</style>
