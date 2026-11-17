<template>
  <!-- Two targets, told apart by what they look like: the cover carries a
     - play mark and plays, the name opens the album. A row in the library
     - opens on a tap because it is a list to pick from; Home is for
     - starting something, so the play is the bigger target here. -->
  <div class="mobile-album-tile" :class="{ 'mobile-album-tile--shelf': shelf }">
    <button
      type="button"
      class="mobile-album-tile__cover"
      :aria-label="`${$t('library.play')}: ${album.name}`"
      @click="$emit('play')"
    >
      <cover-art :cover-art-id="album.coverArtId" :size="coverSize" fallback-icon="mdi-album" />
      <v-icon icon="mdi-play" class="mobile-album-tile__play" />
    </button>
    <router-link :to="`/m/albums/${album.id}`" class="mobile-album-tile__text">
      <span class="mobile-album-tile__name text-body-small">{{ album.name }}</span>
      <span class="text-body-small text-medium-emphasis">{{ album.artist }}</span>
    </router-link>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from '@/components/library/CoverArt.vue'
import type { Album } from '@/types/library'

/** The tile's cover fills its 64px height less its padding. */
const TILE_COVER_SIZE = 54
/** A shelf's cover: two and a half of them across a phone, so the row
 * shows that it goes on. */
const SHELF_COVER_SIZE = 132

export default {
  name: 'MobileAlbumTile',
  components: { CoverArt },
  props: {
    album: { type: Object as PropType<Album>, required: true },
    /** The cover on top of the name, for a sideways-scrolling row, rather
     * than beside it. */
    shelf: { type: Boolean, default: false },
  },
  emits: ['play'],
  computed: {
    coverSize(): number {
      return this.shelf ? SHELF_COVER_SIZE : TILE_COVER_SIZE
    },
  },
}
</script>

<style scoped>
/* The tile form: Home's desktop tiles (AlbumCard's `tile`) at phone size -
 * a panel's 2% fill at the tile radius. */
.mobile-album-tile {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  height: 64px;
  padding: 4px 8px 4px 4px;
  border-radius: 12px;
  border: 1px solid var(--beacon-hairline);
  background: rgba(var(--v-theme-on-surface), 0.02);
}

.mobile-album-tile--shelf {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  width: 132px;
  height: auto;
  padding: 0;
  border: none;
  border-radius: 0;
  background: none;
}

.mobile-album-tile__cover {
  position: relative;
  flex-shrink: 0;
  padding: 0;
  border: none;
  background: none;
  border-radius: 4px;
  overflow: hidden;
  cursor: pointer;
}

/* A dark pill behind the mark rather than a scrim over the whole cover,
 * which would dim the very picture that says which album this is. */
.mobile-album-tile__play {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  font-size: 20px;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
}

.mobile-album-tile--shelf .mobile-album-tile__play {
  width: 40px;
  height: 40px;
  font-size: 26px;
}

.mobile-album-tile__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  color: inherit;
  text-decoration: none;
}

.mobile-album-tile__text > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-album-tile__name {
  font-weight: 600;
}
</style>
