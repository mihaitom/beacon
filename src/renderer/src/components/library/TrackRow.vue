<template>
  <div
    class="track-row d-flex align-center px-2 py-1"
    :class="{ 'track-row--current': isCurrentTrack, 'track-row--selected': selected }"
    @click="selectionMode && $emit('toggle-select', track, index)"
    @dblclick="$emit('play', track, index)"
    @contextmenu.prevent="openMenu($event)"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <div class="track-index text-medium-emphasis text-caption">
      <v-checkbox-btn
        v-if="selectionMode || isHovered"
        :model-value="selected"
        density="compact"
        class="track-select-checkbox"
        @click.stop="$emit('toggle-select', track, index)"
      />
      <template v-else-if="isCurrentTrack">
        <v-icon icon="mdi-volume-high" size="14" color="primary" />
      </template>
      <template v-else>{{ displayNumber ?? (index != null ? index + 1 : '') }}</template>
    </div>
    <cover-art v-if="showCover" :cover-art-id="track.coverArtId" :size="40" class="track-cover" />
    <div class="track-title min-width-0">
      <div class="text-body-2 text-truncate" :class="{ 'text-primary': isCurrentTrack }">
        {{ track.title }}
      </div>
      <div class="text-caption text-medium-emphasis text-truncate">{{ track.artist }}</div>
    </div>
    <router-link
      v-if="showAlbum"
      :to="`/albums/${track.albumId}`"
      class="track-album text-caption text-medium-emphasis text-truncate"
      @click.stop
    >
      {{ track.album }}
    </router-link>
    <div v-if="showGenre" class="track-genre text-caption text-medium-emphasis text-truncate">
      {{ track.genre || '—' }}
    </div>
    <div v-if="showYear" class="track-year text-caption text-medium-emphasis">
      {{ track.year || '—' }}
    </div>
    <div v-if="showPlayCount" class="track-playcount text-caption text-medium-emphasis">
      {{ track.playCount }}
    </div>
    <div v-if="showFormat" class="track-format text-caption text-medium-emphasis text-truncate">
      {{ formattedFormat }}
    </div>
    <div class="track-duration text-caption text-medium-emphasis">
      {{ formattedDuration }}
    </div>
    <div class="track-actions d-flex align-center">
      <transition name="rating-fade" style="margin-right: 1rem">
        <v-rating
          v-if="authStore.capabilities.personalRating && (track.rating > 0 || isHovered)"
          :model-value="track.rating"
          length="5"
          size="small"
          density="compact"
          active-color="primary"
          hover
          clearable
          class="track-rating"
          @click.stop
          @update:model-value="$emit('set-rating', { track, rating: $event })"
        />
      </transition>
      <v-btn
        :icon="track.starred ? 'mdi-heart' : 'mdi-heart-outline'"
        :color="track.starred ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        size="small"
        @click.stop="$emit('toggle-star', track)"
      />
      <v-btn
        icon="mdi-dots-vertical"
        variant="text"
        density="comfortable"
        size="small"
        @click.stop="openMenu($event)"
      />
    </div>

    <!-- Detached from any single activator element — :target accepts either
     - the triggering element (the "..." button click) or raw [x, y]
     - coordinates (right-click), so the same menu serves both. -->
    <v-menu v-model="menuOpen" :target="menuTarget">
      <v-list density="compact">
        <v-list-item @click="$emit('play', track, index)">
          <template #prepend><v-icon icon="mdi-play" size="small" /></template>
          <v-list-item-title>{{ $t('library.play') }}</v-list-item-title>
        </v-list-item>
        <v-list-item @click="$emit('play-next', track, index)">
          <template #prepend><v-icon icon="mdi-skip-next-outline" size="small" /></template>
          <v-list-item-title>{{ $t('library.playNext') }}</v-list-item-title>
        </v-list-item>
        <v-list-item v-if="authStore.capabilities.trackRadio" @click="$emit('track-radio', track)">
          <template #prepend><v-icon icon="mdi-radio-tower" size="small" /></template>
          <v-list-item-title>{{ $t('library.trackRadio') }}</v-list-item-title>
        </v-list-item>
        <v-divider />
        <v-list-item @click="$emit('add-to-queue', track, index)">
          <template #prepend><v-icon icon="mdi-playlist-plus" size="small" /></template>
          <v-list-item-title>{{ $t('common.addToQueue') }}</v-list-item-title>
        </v-list-item>
        <v-menu submenu>
          <template #activator="{ props: submenuProps }">
            <v-list-item v-bind="submenuProps">
              <template #prepend><v-icon icon="mdi-playlist-music" size="small" /></template>
              <v-list-item-title>{{ $t('common.addToPlaylistMenu') }}</v-list-item-title>
              <template #append><v-icon icon="mdi-menu-right" size="small" /></template>
            </v-list-item>
          </template>
          <v-list density="compact" class="playlist-submenu">
            <v-list-item v-if="libraryStore.playlists.length === 0" disabled>
              <v-list-item-title class="text-medium-emphasis">{{
                $t('common.noPlaylists')
              }}</v-list-item-title>
            </v-list-item>
            <v-list-item
              v-for="playlist in libraryStore.playlists"
              :key="playlist.id"
              @click="$emit('add-to-playlist', { track, playlistId: playlist.id, index })"
            >
              <v-list-item-title>{{ playlist.name }}</v-list-item-title>
            </v-list-item>
          </v-list>
        </v-menu>
      </v-list>
    </v-menu>
  </div>
</template>

<script lang="ts">
import CoverArt from './CoverArt.vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'

export default {
  name: 'TrackRow',
  components: { CoverArt },
  props: {
    track: {
      type: Object,
      required: true,
    },
    // Absolute position in the (sorted) list this row belongs to — used
    // for queueing on play, and as the display fallback when
    // displayNumber isn't given.
    index: {
      type: Number,
      default: null,
    },
    // Overrides the shown number with the track's real per-disc track
    // number (see TrackList.vue's groupByDisc) — kept separate from
    // `index` since that one must stay the absolute position for
    // queueing regardless of how the number is displayed.
    displayNumber: {
      type: Number,
      default: null,
    },
    showCover: {
      type: Boolean,
      default: false,
    },
    showAlbum: {
      type: Boolean,
      default: false,
    },
    showGenre: {
      type: Boolean,
      default: false,
    },
    showYear: {
      type: Boolean,
      default: false,
    },
    showPlayCount: {
      type: Boolean,
      default: false,
    },
    showFormat: {
      type: Boolean,
      default: false,
    },
    // True once at least one row in the list is selected — see
    // TrackList.vue's selectionMode getter. Reveals every row's checkbox
    // (not just the hovered one) so the rest of a multi-track selection can
    // be built up without needing to hover each row individually, and
    // turns a plain click anywhere on a row into a toggle instead of a
    // no-op.
    selectionMode: {
      type: Boolean,
      default: false,
    },
    selected: {
      type: Boolean,
      default: false,
    },
  },
  emits: [
    'play',
    'play-next',
    'track-radio',
    'toggle-star',
    'set-rating',
    'add-to-queue',
    'add-to-playlist',
    'toggle-select',
  ],
  data() {
    return {
      menuOpen: false,
      menuTarget: [0, 0] as [number, number],
      isHovered: false,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    playbackStore() {
      return usePlaybackStore()
    },
    authStore() {
      return useAuthStore()
    },
    isCurrentTrack() {
      return this.playbackStore.currentTrack?.id === this.track.id
    },
    formattedDuration() {
      const total = Math.round(this.track.duration ?? 0)
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return `${minutes}:${String(seconds).padStart(2, '0')}`
    },
    formattedFormat() {
      const format = this.track.format ? this.track.format.toUpperCase() : null
      const bitRate = this.track.bitRate ? `${this.track.bitRate} kbps` : null
      if (format && bitRate) return `${format} · ${bitRate}`
      return format || bitRate || '—'
    },
  },
  methods: {
    openMenu(event: MouseEvent) {
      this.menuTarget = [event.clientX, event.clientY]
      this.menuOpen = true
      // Fetched eagerly (not on-demand when the submenu opens) so the
      // playlist list is already there by the time it's hovered — playlist
      // counts are small enough that this is cheap, and it only ever
      // happens once per session.
      if (this.libraryStore.playlists.length === 0) {
        void this.libraryStore.fetchPlaylists()
      }
    },
  },
}
</script>

<style scoped>
.playlist-submenu {
  max-height: 320px;
  overflow-y: auto;
}

.track-row {
  cursor: default;
  border-radius: 4px;
  gap: 12px;
  /* Otherwise a double-click to play (see @dblclick above) also selects
   * the title/artist text underneath it, like any other double-click on
   * plain text would. */
  user-select: none;
}

.track-row:hover {
  background: var(--beacon-hover);
}

.track-row--current {
  background: rgba(var(--v-theme-primary), 0.08);
}

.track-row--current:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}

.track-row--selected {
  background: rgba(var(--v-theme-primary), 0.14);
}

.track-row--selected:hover {
  background: rgba(var(--v-theme-primary), 0.18);
}

/* Widths/flex-grow here must mirror TrackListHeader.vue's exactly, column
 * for column, or the header labels drift out of alignment with the rows. */
.track-select-checkbox {
  /* Overrides v-checkbox-btn's default hit-area padding, which is sized
   * for a standalone checkbox, not a 28px-wide index column — without
   * this it visually pushes into the next column. */
  margin: 0 -8px;
}

.track-index {
  flex: 0 0 28px;
  text-align: right;
}

.track-cover {
  flex: 0 0 auto;
}

.track-title {
  flex: 3 1 160px;
}

.track-album {
  flex: 2 1 120px;
  min-width: 0;
  text-decoration: none;
}

.track-album:hover {
  color: rgb(var(--v-theme-primary));
}

.track-genre {
  flex: 1.5 1 90px;
  min-width: 0;
}

.track-year {
  flex: 0 0 44px;
  text-align: right;
}

.track-playcount {
  flex: 0 0 44px;
  text-align: right;
}

.track-format {
  flex: 0 0 120px;
  text-align: right;
}

.track-duration {
  flex: 0 0 44px;
  text-align: right;
}

.track-actions {
  flex: 0 0 200px;
  justify-content: flex-end;
}

.track-rating :deep(.v-icon) {
  font-size: 16px;
}

.rating-fade-enter-active,
.rating-fade-leave-active {
  transition: opacity 0.15s ease;
}

.rating-fade-enter-from,
.rating-fade-leave-to {
  opacity: 0;
}

.min-width-0 {
  min-width: 0;
}
</style>
