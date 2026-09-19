<template>
  <card-shelf v-if="songs.length || loading" ref="shelf" :title="title">
    <template #action>
      <v-btn
        v-if="songs.length && !loading"
        icon="mdi-play-circle-outline"
        variant="text"
        size="small"
        density="comfortable"
        :title="$t('home.playAll')"
        @click="$emit('play-all')"
      />
      <slot name="action" />
    </template>
    <template v-if="loading">
      <div v-for="n in skeletonCount" :key="`skeleton-${n}`" class="song-shelf-skeleton">
        <v-skeleton-loader type="image" width="160" height="160" class="rounded" />
        <v-skeleton-loader type="text" width="70%" height="20" class="song-shelf-skeleton__label" />
        <v-skeleton-loader type="text" width="45%" height="16" />
      </div>
    </template>
    <song-card v-for="song in loading ? [] : songs" :key="song.id" :song="song" />
  </card-shelf>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { Song } from '@/types/library'
import CardShelf from './CardShelf.vue'
import SongCard from './SongCard.vue'
import { observeCardsAcross, skeletonsAcross } from './cardRowFit'

/** A scrolling row of single songs. Hides itself when there is nothing to
 * show - a shelf of songs picked from listening history is empty for
 * anyone without one, and a heading over "nothing to show" says nothing. */
export default {
  name: 'SongShelf',
  components: { CardShelf, SongCard },
  props: {
    title: { type: String, required: true },
    songs: { type: Array as PropType<Song[]>, required: true },
    loading: { type: Boolean, default: false },
  },
  emits: ['play-all'],
  data() {
    return {
      skeletonCount: 6,
      resizeObserver: null as ResizeObserver | null,
    }
  },
  mounted() {
    // The row, not $el - see SimilarArtistsShelf.vue's identical mounted().
    const row = (this.$refs.shelf as InstanceType<typeof CardShelf> | undefined)?.rowElement()
    if (!row) return
    this.resizeObserver = observeCardsAcross(row, (width) => {
      this.skeletonCount = skeletonsAcross(width)
    })
  },
  beforeUnmount() {
    this.resizeObserver?.disconnect()
  },
}
</script>

<style scoped>
.song-shelf-skeleton {
  width: 160px;
}

/* Same bone override as AlbumShelf.vue's, so the placeholders are the size
 * of the SongCards that replace them. */
.song-shelf-skeleton :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}

.song-shelf-skeleton__label {
  margin-top: 8px;
}
</style>
