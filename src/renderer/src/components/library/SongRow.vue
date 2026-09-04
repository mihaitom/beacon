<template>
  <div
    class="song-row d-flex align-center px-2 py-1"
    :class="{
      'song-row--current': isCurrentSong,
      'song-row--selected': selected,
      'song-row--reorderable': reorderable,
      'song-row--drag-over-before': dragOverPosition === 'before',
      'song-row--drag-over-after': dragOverPosition === 'after',
      'song-row--dragging': dragging,
    }"
    :draggable="reorderable"
    @click="selectionMode && $emit('toggle-select', song, index)"
    @dblclick="$emit('play', song, index)"
    @contextmenu.prevent="openMenu($event)"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
    @dragstart="onDragStart"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @dragend="onDragEnd"
  >
    <div class="song-index text-medium-emphasis text-body-small">
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
      <div class="text-body-medium text-truncate" :class="{ 'text-primary': isCurrentSong }">
        {{ song.title }}
      </div>
      <router-link
        :to="`/artists/${song.artistId}`"
        class="song-artist-link text-body-small text-medium-emphasis text-truncate"
        @click.stop
      >
        {{ song.artist }}
      </router-link>
    </div>
    <div v-if="showAlbum" class="song-album">
      <router-link
        :to="`/albums/${song.albumId}`"
        class="song-album-link text-body-small text-medium-emphasis text-truncate"
        @click.stop
      >
        {{ song.album }}
      </router-link>
    </div>
    <div v-if="showGenre" class="song-genre text-body-small text-medium-emphasis text-truncate">
      {{ song.genre || '—' }}
    </div>
    <div v-if="showYear" class="song-year text-body-small text-medium-emphasis">
      {{ song.year || '—' }}
    </div>
    <div v-if="showPlayCount" class="song-playcount text-body-small text-medium-emphasis">
      {{ song.playCount }}
    </div>
    <div v-if="showFormat" class="song-format text-body-small text-medium-emphasis text-truncate">
      {{ formattedFormat }}
    </div>
    <div class="song-duration text-body-small text-medium-emphasis">
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

    <!-- The shared tile/row menu — see TileContextMenu.vue for the
     - positioning, the one-open-at-a-time rule and the scroll lock all of
     - them share. Everything below is this row's own actions. -->
    <tile-context-menu ref="menu">
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
      <!-- Not part of the selection-scoped group below: it shows one
         - picture, so it stays about this one song however many rows happen
         - to be selected — same reasoning as Song Radio above, which hides
         - itself instead. Hidden when the song carries no cover at all. -->
      <v-list-item v-if="song.coverArtId" @click="showArtwork">
        <template #prepend><v-icon icon="mdi-image-outline" size="small" /></template>
        <v-list-item-title>{{ $t('library.showArtwork') }}</v-list-item-title>
      </v-list-item>
      <v-divider />
      <v-list-item @click="$emit('add-to-queue', song, index)">
        <template #prepend><v-icon icon="mdi-playlist-plus" size="small" /></template>
        <v-list-item-title>{{ $t('common.addToQueue') }}</v-list-item-title>
      </v-list-item>
      <add-to-playlist-submenu
        @create="$emit('create-playlist', { song, index })"
        @select="$emit('add-to-playlist', { song, playlistId: $event, index })"
      />
      <!-- The row's own columns already link to both, but a view can hide
         - either of them (see showAlbum) and the player-bar-sized rows show
         - neither — so this is the one way to reach them that is always
         - there. -->
      <v-divider />
      <v-list-item v-if="song.albumId" :to="`/albums/${song.albumId}`">
        <template #prepend><v-icon icon="mdi-album" size="small" /></template>
        <v-list-item-title>{{ $t('library.goToAlbum') }}</v-list-item-title>
      </v-list-item>
      <v-list-item v-if="song.artistId" :to="`/artists/${song.artistId}`">
        <template #prepend><v-icon icon="mdi-account-music" size="small" /></template>
        <v-list-item-title>{{ $t('library.goToArtist') }}</v-list-item-title>
      </v-list-item>
    </tile-context-menu>
  </div>
</template>

<script lang="ts">
import CoverArt from './CoverArt.vue'
import TileContextMenu from './TileContextMenu.vue'
import AddToPlaylistSubmenu from './AddToPlaylistSubmenu.vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'

export default {
  name: 'SongRow',
  components: { CoverArt, TileContextMenu, AddToPlaylistSubmenu },
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
    // Playlist detail's own opt-in (see SongTable.vue's identical prop) —
    // the whole row is the drag handle rather than a separate grip, since
    // every column here has to keep lining up with SongTableHeader.vue and
    // an extra one would push all of them out of alignment.
    reorderable: {
      type: Boolean,
      default: false,
    },
    // Which side of this row a drop would land on — same two-position
    // indicator QueueRow.vue uses, and for the same reason: one
    // undifferentiated "drag-over" highlight can't say which side of the
    // boundary the dragged song is about to land on.
    dragOverPosition: {
      type: String as () => 'before' | 'after' | null,
      default: null,
    },
    dragging: {
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
    'dragstart',
    'dragover',
    'dragleave',
    'drop',
    'dragend',
  ],
  data() {
    return {
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
  methods: {
    /** Shows this song's cover full size, through the app-wide viewer
     * (ArtworkLightbox.vue in App.vue) rather than as an event this row's
     * parents would have to carry — SongTable.vue sits under a dozen
     * different views, none of which have anything to do with a picture. */
    showArtwork(): void {
      this.$emitter.emit('showArtwork', {
        coverArtId: this.song.coverArtId,
        title: this.song.title,
        subtitle: this.song.album || this.song.artist,
      })
    },
    // Every one of these is a no-op unless this row was actually made
    // reorderable — the listeners are bound unconditionally (a template
    // can't add them conditionally without duplicating the whole element),
    // so the guard lives here instead. Without it, dragover's
    // preventDefault() would mark every song row in the app as a drop
    // target for anything at all, files included.
    onDragStart(event: DragEvent) {
      if (!this.reorderable) return
      // Firefox refuses to start a drag at all without data on it.
      event.dataTransfer?.setData('text/plain', String(this.index))
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      this.$emit('dragstart', this.index)
    },
    onDragOver(event: DragEvent) {
      if (!this.reorderable) return
      // The default action is "reject the drop" — a dragover that isn't
      // prevented means no drop event ever fires here.
      event.preventDefault()
      this.$emit('dragover', { index: this.index, event })
    },
    onDragLeave() {
      if (!this.reorderable) return
      this.$emit('dragleave', this.index)
    },
    onDrop(event: DragEvent) {
      if (!this.reorderable) return
      event.preventDefault()
      this.$emit('drop', { index: this.index, event })
    },
    onDragEnd() {
      if (!this.reorderable) return
      this.$emit('dragend')
    },
    onCoverClick() {
      if (this.selectionMode) this.$emit('toggle-select', this.song, this.index)
      else this.$emit('play', this.song, this.index)
    },
    openMenu(event: MouseEvent) {
      ;(this.$refs.menu as { open: (event: MouseEvent) => void } | undefined)?.open(event)
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

/* Only in a list that can actually be reordered (playlist detail) — the
 * grab cursor is the only thing announcing that a row can be picked up at
 * all, since there's no room for a separate handle column. */
.song-row--reorderable {
  cursor: grab;
  transition: opacity 0.15s ease;
}

/* An inset shadow rather than a border, unlike QueueRow.vue's own drop
 * indicator: a border would add its 2px to the row's height, and
 * v-virtual-scroll positions rows off a fixed item-height (see
 * SongTable.vue), so a long playlist would drift by 2px per row. */
.song-row--drag-over-before {
  box-shadow: inset 0 2px 0 0 rgb(var(--v-theme-primary));
}

.song-row--drag-over-after {
  box-shadow: inset 0 -2px 0 0 rgb(var(--v-theme-primary));
}

.song-row--dragging {
  opacity: 0.4;
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
