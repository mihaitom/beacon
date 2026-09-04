<template>
  <div class="tile-skeleton">
    <v-skeleton-loader
      type="image"
      :width="coverSize"
      :height="coverSize"
      class="rounded tile-skeleton__cover"
    />
    <div class="tile-skeleton__info">
      <v-skeleton-loader type="text" width="70%" height="20" />
      <v-skeleton-loader type="text" width="45%" height="16" />
    </div>
  </div>
</template>

<script lang="ts">
/**
 * The placeholder for one horizontal library tile (PlaylistTile.vue,
 * RadioStationCard.vue) while its list is still loading.
 *
 * Same box, same width, same padding as the real tile, so the grid it fills
 * is exactly the grid that replaces it — a spinner used to sit above the
 * content instead, which meant the whole page jumped down while it was
 * there and back up when it went. That jump was most obvious not on the
 * first load but mid-browse: the loading flag it watched is the library
 * store's own, which any background fetch sets (a tile's context menu
 * fetching an album's tracks, say).
 */
export default {
  name: 'TileSkeleton',
  props: {
    /** Matches whichever tile this stands in for — 88 for a playlist, 72
     * for a radio station. */
    coverSize: { type: Number, default: 88 },
  },
}
</script>

<style scoped>
/* Deliberately duplicates the two tiles' own chrome rather than importing
 * it: the placeholder has to look like the tile even while the tile itself
 * is nowhere on screen, and a shared class would tie three components'
 * scoped styles together for a box that is six declarations long. */
.tile-skeleton {
  display: flex;
  align-items: center;
  width: 360px;
  padding: 10px 12px 10px 10px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--beacon-hairline);
}

.tile-skeleton__cover {
  flex-shrink: 0;
  margin-right: 14px;
  background: transparent;
}

.tile-skeleton__info {
  flex: 1 1 auto;
  min-width: 0;
}

@media (max-width: 600px) {
  .tile-skeleton {
    width: 100%;
  }
}
</style>
