<template>
  <div
    class="album-card"
    :class="{
      'album-card--row': row,
      'album-card--tile': tile,
    }"
    :style="row ? { gridTemplateColumns: rowTemplate } : undefined"
    @click="onCardClick"
    @contextmenu.prevent="openMenu"
  >
    <!-- The album list's row form (AlbumsView.vue's list toggle): the same
     - component as the card, so the two share the menu, the heart and every
     - action below rather than keeping two copies in step. -->
    <template v-if="tile">
      <div class="album-tile__cover">
        <cover-art :cover-art-id="album.coverArtId" :size="56" />
        <div class="album-tile__play">
          <v-icon icon="mdi-play" size="28" />
        </div>
      </div>
      <div class="album-tile__text">
        <router-link
          :to="`/albums/${album.id}`"
          class="album-tile__name text-body-medium"
          :title="album.name"
          @click.stop
        >
          {{ album.name }}
        </router-link>
        <router-link
          v-if="album.artistId"
          :to="`/artists/${album.artistId}`"
          class="album-tile__artist text-body-small text-medium-emphasis"
          @click.stop
        >
          {{ album.artist }}
        </router-link>
        <div v-else class="album-tile__artist text-body-small text-medium-emphasis">
          {{ album.artist }}
        </div>
      </div>
      <v-btn
        v-if="authStore.capabilities.favorites"
        :icon="album.starred ? 'mdi-heart' : 'mdi-heart-outline'"
        :color="album.starred ? 'primary' : undefined"
        size="small"
        variant="text"
        class="album-row__star"
        :class="{ 'album-row__star--visible': album.starred }"
        :title="$t(album.starred ? 'library.unstar' : 'library.star')"
        @click.stop="toggleStar"
      />
    </template>
    <template v-else-if="row">
      <template v-for="column in rowColumns" :key="column.key">
        <cover-art
          v-if="column.key === 'cover'"
          :cover-art-id="album.coverArtId"
          :size="44"
          class="album-row__cover"
        />
        <div v-else-if="column.key === 'name'" class="album-row__text">
          <div class="album-row__name text-body-medium" :title="album.name">{{ album.name }}</div>
          <router-link
            v-if="album.artistId"
            :to="`/artists/${album.artistId}`"
            class="album-row__artist text-body-small text-medium-emphasis"
            @click.stop
          >
            {{ album.artist }}
          </router-link>
          <div v-else class="album-row__artist text-body-small text-medium-emphasis">
            {{ album.artist }}
          </div>
        </div>
        <rating-stars
          v-else-if="column.key === 'rating'"
          :item="album"
          class="album-row__rating"
          :class="{ 'album-row__rating--set': album.rating > 0 }"
        />
        <template v-else-if="column.key === 'star'">
          <v-btn
            v-if="authStore.capabilities.favorites"
            :icon="album.starred ? 'mdi-heart' : 'mdi-heart-outline'"
            :color="album.starred ? 'primary' : undefined"
            size="small"
            variant="text"
            class="album-row__star"
            :class="{ 'album-row__star--visible': album.starred }"
            :title="$t(album.starred ? 'library.unstar' : 'library.star')"
            @click.stop="toggleStar"
          />
          <span v-else />
        </template>
        <span
          v-else
          class="album-row__figure text-body-small text-medium-emphasis"
          :class="{ 'album-row__figure--start': column.align === 'start' }"
          :title="cellText(column.key)"
          >{{ cellText(column.key) }}</span
        >
      </template>
    </template>
    <template v-else>
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
        class="album-card-title text-body-medium"
        @click.stop
      >
        {{ album.name }}
      </router-link>
      <div v-else class="album-card-title text-body-medium">{{ album.name }}</div>
      <router-link
        :to="`/artists/${album.artistId}`"
        class="album-card-artist text-body-small text-medium-emphasis"
        @click.stop
      >
        {{ album.artist }}
      </router-link>
    </template>
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
      <rating-item :item="album" />
      <add-to-playlist-submenu @create="createPlaylist" @select="addToPlaylist" />
      <context-menu-section :label="$t('library.menuNavigation')" />
      <v-list-item v-if="album.artistId" :to="`/artists/${album.artistId}`">
        <template #prepend><v-icon icon="mdi-account-music" size="small" /></template>
        <v-list-item-title>{{ $t('library.goToArtist') }}</v-list-item-title>
      </v-list-item>
      <!-- Artwork is the section's only entry, so without it the heading
         - would stand over nothing. -->
      <template v-if="album.coverArtId">
        <context-menu-section :label="$t('library.menuDetails')" />
        <v-list-item @click="showArtwork">
          <template #prepend><v-icon icon="mdi-image-outline" size="small" /></template>
          <v-list-item-title>{{ $t('library.showArtwork') }}</v-list-item-title>
        </v-list-item>
      </template>
    </tile-context-menu>
    <create-playlist-dialog ref="createDialog" />
  </div>
</template>

<script lang="ts">
import CoverArt from './CoverArt.vue'
import TileContextMenu from './TileContextMenu.vue'
import ContextMenuSection from './ContextMenuSection.vue'
import AddToPlaylistSubmenu from './AddToPlaylistSubmenu.vue'
import RatingItem from './RatingItem.vue'
import RatingStars from './RatingStars.vue'
import CreatePlaylistDialog from './CreatePlaylistDialog.vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { emitter } from '@/emitter'
import type { PropType } from 'vue'
import { formatDate, formatDuration } from '@/services/library/songFormat'
import { filterOptionLabel } from '@/services/library/libraryFilter'
import {
  albumColumnTemplate,
  albumColumnsFor,
  type AlbumColumn,
  type AlbumColumnKey,
} from '@/services/library/albumColumns'
import type { Album, Song } from '@/types/library'

/** The columns a row draws when its list does not say: the set a list of
 * ordinary width shows. */
const DEFAULT_LIST_WIDTH = 640

export default {
  name: 'AlbumCard',
  components: {
    CoverArt,
    TileContextMenu,
    ContextMenuSection,
    AddToPlaylistSubmenu,
    RatingItem,
    RatingStars,
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
    // One line of a list instead of a tile - see the template.
    row: {
      type: Boolean,
      default: false,
    },
    // Which of the list's columns this line draws - the list picks them by
    // its width (see albumColumns.ts).
    columns: {
      type: Array as PropType<AlbumColumn[] | null>,
      default: null,
    },
    // A small wide tile - cover beside the name - for Home's recently
    // played grid. The whole tile plays, since that grid is there to get
    // back into something; the name still leads to the album.
    tile: {
      type: Boolean,
      default: false,
    },
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    rowColumns(): AlbumColumn[] {
      return (
        this.columns ??
        albumColumnsFor(DEFAULT_LIST_WIDTH, this.authStore.capabilities.personalRating)
      )
    },
    rowTemplate(): string {
      return albumColumnTemplate(this.rowColumns)
    },
  },
  methods: {
    cellText(key: AlbumColumnKey): string {
      const album = this.album
      switch (key) {
        case 'genre':
          return album.genre ?? ''
        case 'releaseType':
          return album.releaseTypes?.length
            ? filterOptionLabel('releaseType', album.releaseTypes[0]!, this.$t)
            : ''
        case 'year':
          return album.year ? String(album.year) : ''
        case 'songCount':
          return this.$t('library.songCount', { count: this.$n(album.songCount) })
        case 'duration':
          return formatDuration(album.duration) ?? ''
        case 'added':
          return formatDate(album.created, this.$i18n.locale) ?? ''
        default:
          return ''
      }
    },
    onCardClick(): void {
      if (this.tile) void this.onCoverClick()
      else if (!this.playOnClick) void this.$router.push(`/albums/${this.album.id}`)
    },
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
      await useLibraryStore().toggleFavorite('album', this.album)
    },
  },
}
</script>

<style scoped>
.album-card {
  width: 160px;
  cursor: pointer;
}

/* Cover, name over artist, then the figures in fixed columns so they line
 * up down the list, and the heart - which columns, and how wide, comes from
 * albumColumns.ts. Right-aligned figures are tabular, or the column wobbles
 * as it scrolls (see docs/styleguide.md). */
.album-card--row {
  width: 100%;
  height: 56px;
  display: grid;
  align-items: center;
  gap: 16px;
  padding: 0 8px;
  border-radius: 8px;
}

.album-card--row:hover {
  background: var(--beacon-hover);
}

.album-row__text {
  min-width: 0;
}

.album-row__name,
.album-row__artist {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.album-card--row:hover .album-row__name {
  color: rgb(var(--v-theme-primary));
}

.album-row__artist {
  color: inherit;
  text-decoration: none;
}

.album-row__artist:hover {
  text-decoration: underline;
}

.album-row__figure {
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.album-row__figure--start {
  text-align: left;
}

/* Shown once set, or on hover like the heart: an unrated library would
 * otherwise have five hollow stars on every line. On a touch screen there
 * is no hover to reveal them, so an unrated row's stars are not there at
 * all rather than invisible but tappable - the right-click menu's own star
 * row is how a phone rates. */
.album-row__rating {
  justify-self: end;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.album-card--row:hover .album-row__rating,
.album-row__rating--set {
  opacity: 1;
}

/* Shown on hover and once set, like the card's. */
.album-row__star {
  opacity: 0;
}

.album-card--row:hover .album-row__star,
.album-card--tile:hover .album-row__star,
.album-row__star--visible {
  opacity: 1;
}

/* A raised area of the page, like a panel, at the tile step of the radius
 * ladder. It does not lift on hover (see docs/styleguide.md, Lists). */
.album-card--tile {
  width: auto;
  min-width: 0;
  height: 72px;
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) 40px;
  align-items: center;
  gap: 14px;
  padding: 0 4px 0 8px;
  border-radius: 12px;
  background: rgba(var(--v-theme-on-surface), 0.04);
  transition: background-color 0.15s ease;
}

.album-card--tile:hover {
  background: var(--beacon-hover);
}

.album-tile__cover {
  position: relative;
  border-radius: 4px;
  overflow: hidden;
}

.album-tile__play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  background: rgba(11, 13, 19, 0.45);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.album-card--tile:hover .album-tile__play {
  opacity: 1;
}

.album-tile__text {
  min-width: 0;
}

.album-tile__name,
.album-tile__artist {
  display: block;
  width: fit-content;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: inherit;
  text-decoration: none;
}

.album-tile__name {
  font-weight: 600;
}

.album-card--tile:hover .album-tile__name {
  color: rgb(var(--v-theme-primary));
}

a.album-tile__artist:hover {
  text-decoration: underline;
}

@media (hover: none) {
  .album-row__star {
    opacity: 1;
  }

  .album-row__rating:not(.album-row__rating--set) {
    visibility: hidden;
  }
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

/* Invisible is not inactive: without hover, a tap on the cover's corner
 * would star the album, and one on the cover would play it, unannounced. */
@media (hover: none) {
  .album-card-star,
  .album-card-play-overlay {
    opacity: 1;
  }
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
  /* The ellipsis rule below needs a block-level box with a bounded width
   * to work against — an <a>'s default `inline` display doesn't respect
   * that. */
  display: block;
  text-decoration: none;
  width: fit-content;
  max-width: 100%;
}

.album-card-artist:hover {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
}

/* Both lines under the cover stay single. */
.album-card-title,
.album-card-artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The gap between the cover and the title under it. */
.album-card-title {
  margin-top: 8px;
}
</style>
