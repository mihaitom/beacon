<template>
  <div
    class="song-row d-flex align-center px-2 py-1"
    :class="{ 'song-row--current': isCurrentSong, 'song-row--selected': selected }"
    @click="selectionMode && $emit('toggle-select', song, index)"
    @dblclick="$emit('play', song, index)"
    @contextmenu.prevent="openMenu($event)"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <div class="song-index text-medium-emphasis text-caption">
      <v-checkbox-btn
        v-if="selectionMode || isHovered"
        :model-value="selected"
        density="compact"
        class="song-select-checkbox"
        @click.stop="$emit('toggle-select', song, index)"
      />
      <template v-else-if="isCurrentSong">
        <v-icon icon="mdi-volume-high" size="14" color="primary" />
      </template>
      <template v-else>{{ displayNumber ?? (index != null ? index + 1 : '') }}</template>
    </div>
    <!-- Single click plays (or, mid-selection, toggles select like the rest
     - of the row) — previously non-interactive, just a static thumbnail,
     - unlike dblclick-anywhere-on-the-row which already played. -->
    <cover-art
      v-if="showCover"
      :cover-art-id="song.coverArtId"
      :size="40"
      class="song-cover"
      @click.stop="onCoverClick"
    />
    <div class="song-title min-width-0">
      <div class="text-body-2 text-truncate" :class="{ 'text-primary': isCurrentSong }">
        {{ song.title }}
      </div>
      <router-link
        :to="`/artists/${song.artistId}`"
        class="song-artist-link text-caption text-medium-emphasis text-truncate"
        @click.stop
      >
        {{ song.artist }}
      </router-link>
    </div>
    <div v-if="showAlbum" class="song-album">
      <router-link
        :to="`/albums/${song.albumId}`"
        class="song-album-link text-caption text-medium-emphasis text-truncate"
        @click.stop
      >
        {{ song.album }}
      </router-link>
    </div>
    <div v-if="showGenre" class="song-genre text-caption text-medium-emphasis text-truncate">
      {{ song.genre || '—' }}
    </div>
    <div v-if="showYear" class="song-year text-caption text-medium-emphasis">
      {{ song.year || '—' }}
    </div>
    <div v-if="showPlayCount" class="song-playcount text-caption text-medium-emphasis">
      {{ song.playCount }}
    </div>
    <div v-if="showFormat" class="song-format text-caption text-medium-emphasis text-truncate">
      {{ formattedFormat }}
    </div>
    <div class="song-duration text-caption text-medium-emphasis">
      {{ formattedDuration }}
    </div>
    <div class="song-actions d-flex align-center">
      <transition name="rating-fade" style="margin-right: 1rem">
        <v-rating
          v-if="authStore.capabilities.personalRating && (song.rating > 0 || isHovered)"
          :model-value="song.rating"
          length="5"
          size="small"
          density="compact"
          active-color="primary"
          hover
          clearable
          class="song-rating"
          @click.stop
          @update:model-value="$emit('set-rating', { song, rating: $event })"
        />
      </transition>
      <v-btn
        v-if="authStore.capabilities.favorites"
        :icon="song.starred ? 'mdi-heart' : 'mdi-heart-outline'"
        :color="song.starred ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        size="small"
        @click.stop="$emit('toggle-star', song)"
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
        <!-- Only when this row is itself part of a multi-selection (not
         - just "some selection exists elsewhere") — matches
         - SongTable.vue's selectedOrSingle(), the same condition under
         - which Play Next/Add to Queue/Add to Playlist below actually act
         - on the whole selection instead of just this one song. Makes that
         - otherwise-invisible scope switch visible before anything's
         - clicked. -->
        <v-list-subheader v-if="showSelectionSubheader">
          {{ selectedCount }}
          {{ selectedCount === 1 ? $t('library.song1') : $t('library.songsN') }}
          {{ $t('library.selected') }}
        </v-list-subheader>
        <!-- Play has a real "whole selection" reading too — see
         - SongTable.vue's playSong(), which replaces the queue with the
         - selection and starts the first one instead of starting the full
         - list from this song's position, same as Play Next/Add to
         - Queue/Add to Playlist below (selectedOrSingle). Song Radio
         - doesn't: it always seeds a fresh queue off just this one track,
         - so it hides once this row is part of an actual multi-selection
         - instead of offering an action that silently ignores everything
         - else selected. -->
        <v-list-item @click="$emit('play', song, index)">
          <template #prepend><v-icon icon="mdi-play" size="small" /></template>
          <v-list-item-title>{{ $t('library.play') }}</v-list-item-title>
        </v-list-item>
        <v-list-item @click="$emit('play-next', song, index)">
          <template #prepend><v-icon icon="mdi-skip-next-outline" size="small" /></template>
          <v-list-item-title>{{ $t('library.playNext') }}</v-list-item-title>
        </v-list-item>
        <v-list-item
          v-if="authStore.capabilities.songRadio && !showSelectionSubheader"
          @click="$emit('song-radio', song)"
        >
          <template #prepend><v-icon icon="mdi-radio-tower" size="small" /></template>
          <v-list-item-title>{{ $t('library.songRadio') }}</v-list-item-title>
        </v-list-item>
        <v-divider />
        <v-list-item @click="$emit('add-to-queue', song, index)">
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
            <v-list-item @click="$emit('create-playlist', { song, index })">
              <template #prepend><v-icon icon="mdi-plus" size="small" /></template>
              <v-list-item-title>{{ $t('common.createNewPlaylist') }}</v-list-item-title>
            </v-list-item>
            <template v-if="libraryStore.playlists.length">
              <v-divider />
              <v-list-item
                v-for="playlist in libraryStore.playlists"
                :key="playlist.id"
                @click="$emit('add-to-playlist', { song, playlistId: playlist.id, index })"
              >
                <v-list-item-title>{{ playlist.name }}</v-list-item-title>
              </v-list-item>
            </template>
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

// Gives every SongRow instance its own stable id for the
// contextMenuOpened broadcast below — see menuId's own comment.
let nextMenuId = 0

export default {
  name: 'SongRow',
  components: { CoverArt },
  props: {
    song: {
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
    // Overrides the shown number with the song's real per-disc song
    // number (see SongTable.vue's groupByDisc) — kept separate from
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
    // SongTable.vue's selectionMode getter. Reveals every row's checkbox
    // (not just the hovered one) so the rest of a multi-song selection can
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
    // Total number of selected rows in the list (SongTable.vue's
    // selectedRowKeys.size) — only actually used to label the context
    // menu's subheader when this row is itself part of that selection (see
    // showSelectionSubheader), so the menu makes it obvious a bulk action
    // is about to apply to the whole selection, not just the row that was
    // right-clicked.
    selectedCount: {
      type: Number,
      default: 0,
    },
  },
  emits: [
    'play',
    'play-next',
    'song-radio',
    'toggle-star',
    'set-rating',
    'add-to-queue',
    'add-to-playlist',
    'create-playlist',
    'toggle-select',
  ],
  data() {
    return {
      menuOpen: false,
      menuTarget: [0, 0] as [number, number],
      isHovered: false,
      // Identifies this row's own menu in the contextMenuOpened broadcast —
      // see openMenu()/onOtherMenuOpened() below. A plain incrementing
      // counter rather than the song's id: uniqueness only needs to hold
      // for however long a menu might stay open, and this also can't
      // collide with another row showing the same song twice (e.g. a
      // playlist with a duplicate).
      menuId: nextMenuId++,
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
    isCurrentSong() {
      return this.playbackStore.currentSong?.id === this.song.id
    },
    formattedDuration() {
      const total = Math.round(this.song.duration ?? 0)
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return `${minutes}:${String(seconds).padStart(2, '0')}`
    },
    formattedFormat() {
      const format = this.song.format ? this.song.format.toUpperCase() : null
      const bitRate = this.song.bitRate ? `${this.song.bitRate} kbps` : null
      if (format && bitRate) return `${format} · ${bitRate}`
      return format || bitRate || '—'
    },
    // See the v-list-subheader's own template comment — only once this row
    // is part of an actual multi-selection, not for a lone selected row
    // (where the subheader would just be redundant noise on top of normal
    // single-row behavior).
    showSelectionSubheader() {
      return this.selectionMode && this.selected && this.selectedCount > 1
    },
  },
  mounted() {
    this.$emitter.on('contextMenuOpened', this.onOtherMenuOpened)
  },
  beforeUnmount() {
    this.$emitter.off('contextMenuOpened', this.onOtherMenuOpened)
  },
  methods: {
    onCoverClick() {
      if (this.selectionMode) this.$emit('toggle-select', this.song, this.index)
      else this.$emit('play', this.song, this.index)
    },
    openMenu(event: MouseEvent) {
      this.menuTarget = [event.clientX, event.clientY]
      this.menuOpen = true
      // Tells every other mounted row to close its own menu — see
      // menuId's own comment for why this is needed at all.
      this.$emitter.emit('contextMenuOpened', this.menuId)
      // Fetched eagerly (not on-demand when the submenu opens) so the
      // playlist list is already there by the time it's hovered — playlist
      // counts are small enough that this is cheap, and it only ever
      // happens once per session.
      if (this.libraryStore.playlists.length === 0) {
        void this.libraryStore.fetchPlaylists()
      }
    },
    onOtherMenuOpened(id: number) {
      if (id !== this.menuId) this.menuOpen = false
    },
  },
}
</script>

<style scoped>
.playlist-submenu {
  max-height: 320px;
  overflow-y: auto;
}

.song-row {
  cursor: default;
  border-radius: 4px;
  gap: 12px;
  /* Otherwise a double-click to play (see @dblclick above) also selects
   * the title/artist text underneath it, like any other double-click on
   * plain text would. */
  user-select: none;
}

.song-row:hover {
  background: var(--beacon-hover);
}

.song-row--current {
  background: rgba(var(--v-theme-primary), 0.08);
}

.song-row--current:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}

.song-row--selected {
  background: rgba(var(--v-theme-primary), 0.14);
}

.song-row--selected:hover {
  background: rgba(var(--v-theme-primary), 0.18);
}

/* Widths/flex-grow here must mirror SongTableHeader.vue's exactly, column
 * for column, or the header labels drift out of alignment with the rows. */
.song-select-checkbox {
  /* Overrides v-checkbox-btn's default hit-area padding, which is sized
   * for a standalone checkbox, not a 44px-wide index column — without
   * this it visually pushes into the next column. */
  margin: 0 -8px;
}

/* 44px, same width as the other narrow right-aligned columns
 * (.song-year/.song-playcount/.song-duration below) — comfortably fits a
 * 5-digit track number, tabular-nums so digit width stays consistent
 * regardless of which digits actually show up. */
.song-index {
  flex: 0 0 44px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.song-cover {
  flex: 0 0 auto;
  cursor: pointer;
}

.song-title {
  flex: 3 1 160px;
}

.song-album {
  flex: 2 1 120px;
  min-width: 0;
}

/* Same width: fit-content reasoning as .song-artist-link — .song-album
 * itself stays full-column-width (a flex item, must keep matching
 * SongTableHeader.vue's own .song-album sizing for column alignment), but
 * the actual link inside it is sized to the album name text, not the
 * whole column, so a double-click landing in the empty space next to a
 * short album name doesn't misfire as "go to album page". */
.song-album-link {
  display: block;
  text-decoration: none;
  width: fit-content;
  max-width: 100%;
}

.song-album-link:hover {
  color: rgb(var(--v-theme-primary));
}

.song-artist-link {
  /* text-truncate (Vuetify's utility class, applied inline above) needs a
   * block-level box with a bounded width to actually ellipsize against —
   * an <a>'s default `inline` display doesn't respect that. width:
   * fit-content keeps the actual click/hit area sized to the artist name
   * itself instead of stretching block-level across the rest of the
   * row (which made a double-click-to-play landing anywhere in that
   * empty space misfire as "go to artist page" instead — see
   * AlbumCard.vue's own .album-card-artist for the same fix). */
  display: block;
  text-decoration: none;
  width: fit-content;
  max-width: 100%;
}

.song-artist-link:hover {
  color: rgb(var(--v-theme-primary));
}

.song-genre {
  flex: 1.5 1 90px;
  min-width: 0;
}

.song-year {
  flex: 0 0 44px;
  text-align: right;
}

.song-playcount {
  flex: 0 0 44px;
  text-align: right;
}

.song-format {
  flex: 0 0 120px;
  text-align: right;
}

.song-duration {
  flex: 0 0 44px;
  text-align: right;
}

.song-actions {
  flex: 0 0 200px;
  justify-content: flex-end;
}

.song-rating :deep(.v-icon) {
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
