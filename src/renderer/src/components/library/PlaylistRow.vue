<template>
  <router-link :to="`/playlists/${playlist.id}`" class="playlist-row d-flex align-center">
    <!-- Bigger than the old 56px thumbnail, and the play button now lives
     - on top of it (revealed on hover, same dimmed-backdrop + centered icon
     - language as AlbumCard.vue's own shelf-card overlay) instead of
     - sitting off to the side next to the text. -->
    <div class="playlist-row__cover-wrap">
      <cover-art
        :cover-art-id="playlist.coverArtId"
        :size="64"
        fallback-icon="mdi-playlist-music"
        class="playlist-row__cover cover-shadow"
      />
      <v-btn
        icon="mdi-play-circle"
        variant="text"
        size="large"
        class="playlist-row__play-overlay"
        :title="$t('library.play')"
        @click.prevent.stop="$emit('play', playlist)"
      />
    </div>
    <div class="min-width-0 flex-grow-1">
      <div class="text-body-large text-truncate playlist-row__name">{{ playlist.name }}</div>
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
      class="playlist-row__chevron text-medium-emphasis ml-1"
    />
  </router-link>
</template>

<script lang="ts">
import CoverArt from './CoverArt.vue'
import type { Playlist } from '@/types/library'

export default {
  name: 'PlaylistRow',
  components: { CoverArt },
  props: {
    playlist: {
      type: Object as () => Playlist,
      required: true,
    },
    // Set for rows in the "global playlists" section — every playlist
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
.playlist-row {
  display: flex;
  padding: 8px 12px;
  border-radius: 8px;
  text-decoration: none;
  color: inherit;
  transition: background 0.15s ease;
}

.playlist-row:hover {
  background: var(--beacon-hover);
}

.playlist-row:hover .playlist-row__chevron {
  opacity: 1;
  transform: translateX(2px);
}

.playlist-row:hover .playlist-row__play-overlay {
  opacity: 1;
}

.playlist-row__cover-wrap {
  position: relative;
  flex-shrink: 0;
  margin-right: 16px;
}

.playlist-row__cover {
  flex-shrink: 0;
}

.playlist-row__name {
  font-weight: 500;
}

/* Fills the cover exactly (Vuetify's own icon-button sizing is overridden
 * below) rather than floating a fixed-size circle over it — same dimmed-
 * backdrop language as AlbumCard.vue's .album-card-play-overlay, just a
 * real button here (not a decorative div) since there's no other element
 * on the cover itself to carry the click. */
.playlist-row__play-overlay {
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

.playlist-row__chevron {
  opacity: 0;
  flex-shrink: 0;
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.min-width-0 {
  min-width: 0;
}
</style>
