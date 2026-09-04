<template>
  <router-link :to="`/playlists/${playlist.id}`" class="playlist-tile">
    <!-- Bigger than the old 56px thumbnail this list used to have, and the
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
        :size="56"
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
      <div class="text-body-medium text-truncate playlist-tile__name">{{ playlist.name }}</div>
      <div class="text-body-small text-medium-emphasis text-truncate">{{ meta }}</div>
    </div>
    <v-icon
      v-if="playlist.public"
      icon="mdi-earth"
      size="16"
      class="text-medium-emphasis mx-1"
      :title="$t('playlists.public')"
    />
    <v-icon
      icon="mdi-chevron-right"
      size="20"
      class="playlist-tile__chevron text-medium-emphasis ml-1"
    />
  </router-link>
</template>

<script lang="ts">
import CoverArt from './CoverArt.vue'
import type { Playlist } from '@/types/library'

export default {
  name: 'PlaylistTile',
  components: { CoverArt },
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
  emits: ['play'],
  computed: {
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
.playlist-tile {
  display: flex;
  align-items: center;
  width: 300px;
  padding: 8px 10px 8px 8px;
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
  margin-right: 12px;
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
</style>
