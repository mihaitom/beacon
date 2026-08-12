<template>
  <section class="album-shelf">
    <div class="album-shelf-head">
      <h2 class="section-title">{{ title }}</h2>
      <slot name="action" />
      <v-spacer />
      <div v-if="albums.length && !fitToScreen" class="album-shelf-nav">
        <v-btn
          icon="mdi-chevron-left"
          variant="text"
          size="small"
          density="comfortable"
          @click="scrollRow(-1)"
        />
        <v-btn
          icon="mdi-chevron-right"
          variant="text"
          size="small"
          density="comfortable"
          @click="scrollRow(1)"
        />
      </div>
    </div>
    <div v-if="loading" class="album-shelf-row">
      <div v-for="n in skeletonCount" :key="n" class="album-shelf-skeleton-item">
        <v-skeleton-loader type="image" width="160" height="160" class="rounded" />
        <v-skeleton-loader type="text" width="80%" height="20" class="mt-2" />
        <v-skeleton-loader type="text" width="55%" height="20" />
      </div>
    </div>
    <div
      v-else-if="albums.length"
      ref="row"
      class="album-shelf-row"
      :class="{ 'album-shelf-row--fit': fitToScreen }"
    >
      <album-card v-for="album in displayedAlbums" :key="album.id" :album="album" />
    </div>
    <div v-else class="text-caption text-medium-emphasis">{{ $t('home.nothingToShow') }}</div>
  </section>
</template>

<script lang="ts">
import AlbumCard from './AlbumCard.vue'
import type { Album } from '@/types/library'

// Matches .album-card's fixed width + .album-shelf-row's gap.
const CARD_WIDTH = 160
const CARD_GAP = 20

export default {
  name: 'AlbumShelf',
  components: { AlbumCard },
  props: {
    title: {
      type: String,
      required: true,
    },
    albums: {
      type: Array as () => Album[],
      required: true,
    },
    loading: {
      type: Boolean,
      default: false,
    },
    // When true: no horizontal scroll/chevrons — just show as many albums as
    // fit in one row (measured live, so resizing the window adjusts it).
    // Used for shelves like Discover that already have their own way to get
    // more (the reroll button), where a fixed-size pool to scroll through
    // doesn't add anything.
    fitToScreen: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      visibleCount: 6,
      resizeObserver: null as ResizeObserver | null,
    }
  },
  computed: {
    displayedAlbums(): Album[] {
      if (!this.fitToScreen) return this.albums
      return this.albums.slice(0, this.visibleCount)
    },
    skeletonCount(): number {
      return this.fitToScreen ? this.visibleCount : 6
    },
  },
  mounted() {
    if (!this.fitToScreen) return
    this.resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      this.visibleCount = Math.max(1, Math.floor((width + CARD_GAP) / (CARD_WIDTH + CARD_GAP)))
    })
    this.resizeObserver.observe(this.$el as Element)
  },
  beforeUnmount() {
    this.resizeObserver?.disconnect()
  },
  methods: {
    scrollRow(direction: 1 | -1): void {
      const row = this.$refs.row as HTMLElement | undefined
      if (!row) return
      row.scrollBy({ left: direction * row.clientWidth * 0.8, behavior: 'smooth' })
    },
  },
}
</script>

<style scoped>
.album-shelf {
  margin-bottom: 40px;
}

.album-shelf-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.album-shelf-nav {
  display: flex;
  gap: 4px;
}

.album-shelf-row {
  display: flex;
  gap: 20px;
  overflow-x: auto;
  padding-bottom: 4px;
  scroll-snap-type: x proximity;
}

.album-shelf-row > * {
  flex: 0 0 auto;
  scroll-snap-align: start;
}

.album-shelf-row--fit {
  overflow-x: hidden;
}

.album-shelf-skeleton-item {
  flex: 0 0 auto;
  width: 160px;
}

/* v-skeleton-loader's "image"/"text" bones ignore the component's own
 * width/height props (they keep fixed CSS heights + a 16px margin) — the
 * width/height props only size the outer wrapper. Forcing the bone to fill
 * that wrapper exactly is what makes the skeleton match AlbumCard.vue's
 * real dimensions (160px cover + mt-2 + two 20px text lines) pixel for
 * pixel, so nothing shifts once the real album cards render in. */
.album-shelf-skeleton-item :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}
</style>
