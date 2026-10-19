<template>
  <!-- v-show, not v-if: the grid has to exist from mount for its width to
   - be watched, even while there is nothing in it yet. -->
  <section v-show="albums.length || loading" class="recent-tiles">
    <div class="recent-tiles__head">
      <h2 class="section-title">{{ title }}</h2>
      <v-btn
        v-if="albums.length && !loading"
        icon="mdi-play-circle-outline"
        variant="text"
        size="small"
        density="comfortable"
        :loading="playAllLoading"
        :disabled="playAllLoading"
        :title="$t('home.playAll')"
        @click="$emit('play-all', shown)"
      />
    </div>
    <div ref="grid" class="recent-tiles__grid">
      <template v-if="loading">
        <v-skeleton-loader
          v-for="n in tileCount"
          :key="n"
          type="image"
          height="72"
          class="recent-tiles__skeleton"
        />
      </template>
      <template v-else>
        <album-card v-for="album in shown" :key="album.id" :album="album" tile />
      </template>
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import AlbumCard from '@/components/library/AlbumCard.vue'
import type { Album } from '@/types/library'

// Kept equal to the grid's own minmax() and gap below.
const TILE_MIN_WIDTH = 260
const TILE_GAP = 12
const ROWS = 2

/** Home's way back into what was just playing: two rows of small tiles,
 * as many across as the window holds. Cut to whole rows here rather than
 * clipped in CSS, so a tile that is not shown is not left in the tab order
 * either. */
export default {
  name: 'RecentAlbumTiles',
  components: { AlbumCard },
  props: {
    title: { type: String, required: true },
    albums: { type: Array as PropType<Album[]>, required: true },
    loading: { type: Boolean, default: false },
    playAllLoading: { type: Boolean, default: false },
  },
  emits: ['play-all'],
  data() {
    return {
      columns: 4,
      resizeObserver: null as ResizeObserver | null,
    }
  },
  computed: {
    tileCount(): number {
      return this.columns * ROWS
    },
    shown(): Album[] {
      return this.albums.slice(0, this.tileCount)
    },
  },
  mounted() {
    const grid = this.$refs.grid as HTMLElement | undefined
    if (!grid) return
    const measure = (width: number) => {
      // Zero is a grid not laid out yet (jsdom, a hidden tab), not a narrow one.
      if (width > 0) {
        this.columns = Math.max(1, Math.floor((width + TILE_GAP) / (TILE_MIN_WIDTH + TILE_GAP)))
      }
    }
    measure(grid.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    this.resizeObserver = new ResizeObserver((entries) =>
      measure(entries[0]?.contentRect.width ?? 0),
    )
    this.resizeObserver.observe(grid)
  },
  beforeUnmount() {
    this.resizeObserver?.disconnect()
  },
}
</script>

<style scoped>
.recent-tiles {
  margin-bottom: 40px;
}

.recent-tiles__head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 16px;
}

.recent-tiles__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.recent-tiles__skeleton {
  border-radius: 12px;
  overflow: hidden;
}

.recent-tiles__skeleton :deep(.v-skeleton-loader__bone) {
  margin: 0;
  height: 100%;
}
</style>
