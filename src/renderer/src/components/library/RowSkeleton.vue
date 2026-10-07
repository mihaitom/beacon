<template>
  <div class="row-skeleton">
    <v-skeleton-loader
      type="image"
      :width="coverSize"
      :height="coverSize"
      class="rounded row-skeleton__part"
    />
    <div class="row-skeleton__text">
      <v-skeleton-loader type="text" width="40%" height="24" class="row-skeleton__part" />
      <v-skeleton-loader type="text" width="30%" height="16" class="row-skeleton__part" />
      <v-skeleton-loader type="text" width="55%" height="20" class="row-skeleton__part" />
    </div>
  </div>
</template>

<script lang="ts">
/**
 * The placeholder for one row of the Playlists or Radio list
 * (PlaylistRow.vue, RadioStationRow.vue) while the list is still loading.
 *
 * In the list's own place rather than a spinner above it: a spinner in the
 * flow pushed the whole page down while it was there and back up when it
 * went. That jump was most obvious not on the first load but mid-browse:
 * the loading flag it watched is the library store's own, which any
 * background fetch sets (a menu fetching an album's tracks, say).
 */
export default {
  name: 'RowSkeleton',
  props: {
    /** Matches the artwork of the row this stands in for. */
    coverSize: { type: Number, required: true },
  },
}
</script>

<style scoped>
.row-skeleton {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 14px;
}

.row-skeleton + .row-skeleton {
  border-top: 1px solid var(--beacon-hairline);
}

.row-skeleton__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
}

.row-skeleton__part {
  background: transparent;
}
</style>
