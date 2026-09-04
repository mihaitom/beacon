<template>
  <section class="album-shelf">
    <div class="album-shelf-head">
      <h2 class="section-title">{{ title }}</h2>
      <v-btn
        v-if="albums.length && showPlayAll"
        icon="mdi-play-circle-outline"
        variant="text"
        size="small"
        density="comfortable"
        :loading="playAllLoading"
        :disabled="playAllLoading"
        :title="$t('home.playAll')"
        @click="$emit('play-all')"
      />
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
        <v-skeleton-loader type="text" width="70%" height="20" class="mt-2" />
        <v-skeleton-loader type="text" width="45%" height="16" />
      </div>
    </div>
    <div
      v-else-if="albums.length"
      ref="row"
      class="album-shelf-row"
      :class="{ 'album-shelf-row--fit': fitToScreen }"
    >
      <album-card
        v-for="album in displayedAlbums"
        :key="album.id"
        :album="album"
        :play-on-click="playOnClick"
      />
    </div>
    <div v-else class="text-body-small text-medium-emphasis">{{ $t('home.nothingToShow') }}</div>
  </section>
</template>

<script lang="ts">
import AlbumCard from './AlbumCard.vue'
import type { Album } from '@/types/library'
import { cardsAcross, observeCardsAcross, skeletonsAcross } from './cardRowFit'

// Matches .album-card's fixed width + .album-shelf-row's gap — shared with
// every other shelf, see cardRowFit.ts.

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
    // Parent-owned — fetching every shelf album's full song list (see
    // HomeView.vue's playAllAlbums()) is a real network round-trip per
    // album, worth showing feedback for rather than a silent multi-second
    // pause after the click.
    playAllLoading: {
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
    // Forwarded to every AlbumCard — see its own prop comment. Off by
    // default (this component is also used for plain browse grids
    // elsewhere), HomeView.vue's shelves turn it on.
    playOnClick: {
      type: Boolean,
      default: false,
    },
    // On by default (matches every existing HomeView.vue shelf) — turn off
    // for a shelf with no sensible "play everything in this row" action of
    // its own (e.g. ArtistDetailView.vue's album shelf, which already has
    // Artist Radio for that).
    showPlayAll: {
      type: Boolean,
      default: true,
    },
  },
  emits: ['play-all'],
  data() {
    return {
      visibleCount: 6,
      // Measured on mount and kept up to date, for every shelf rather than
      // only the fit-to-screen ones: `visibleCount` decides how much
      // *content* a fit-to-screen shelf shows, but how many *placeholders*
      // to draw is a question every shelf has, and answering it with a
      // fixed number left a wide window's row half empty while it loaded.
      skeletonsFitting: 6,
      resizeObserver: null as ResizeObserver | null,
    }
  },
  computed: {
    displayedAlbums(): Album[] {
      if (!this.fitToScreen) return this.albums
      return this.albums.slice(0, this.visibleCount)
    },
    skeletonCount(): number {
      return this.skeletonsFitting
    },
  },
  mounted() {
    this.resizeObserver = observeCardsAcross(this.$el as Element, (width) => {
      this.visibleCount = cardsAcross(width)
      this.skeletonsFitting = skeletonsAcross(width)
    })
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
 * real dimensions pixel for pixel, so nothing shifts once the real album
 * cards render in: a 160px cover, mt-2, then the card's two lines at the
 * heights their own type scale gives them — 20px for the title
 * (text-body-medium) and 16px for the artist (text-body-small). */
.album-shelf-skeleton-item :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}
</style>
