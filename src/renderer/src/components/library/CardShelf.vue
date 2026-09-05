<template>
  <!-- The horizontally scrolling row-of-cards shape the Home view uses for
   - its album shelves, as a container that takes any cards at all: a
   - heading, an optional action next to it, the two chevrons, and the
   - scrolling row itself. AlbumShelf.vue and SimilarArtistsShelf.vue
   - predate this and still carry their own copies of the same row; this
   - exists so a third one (the favorites view's artist and album rows)
   - didn't become a fourth. -->
  <section class="card-shelf">
    <div class="card-shelf__head">
      <h2 class="section-title">{{ title }}</h2>
      <slot name="action" />
      <v-spacer />
      <!-- Amber while the grid is on, same "amber means this is on" rule
       - the rest of the app follows. One icon rather than two: the color
       - carries the state, so swapping the glyph would only say it twice. -->
      <v-btn
        v-if="wrapToggle"
        icon="mdi-view-grid-outline"
        :color="wrap ? 'primary' : undefined"
        variant="text"
        size="small"
        density="comfortable"
        :title="$t('library.showAsGrid')"
        @click="$emit('update:wrap', !wrap)"
      />
      <!-- Each chevron goes dim once the row has nothing further that way,
       - and both do while the grid is on.
       -
       - Disabled rather than hidden: this row sits right of the grid toggle
       - that switches it, and removing it lets the spacer pull that toggle
       - out from under the pointer that just clicked it. -->
      <div class="card-shelf__nav">
        <v-btn
          icon="mdi-chevron-left"
          variant="text"
          size="small"
          density="comfortable"
          :disabled="wrap || edges.atStart"
          @click="scrollRow(-1)"
        />
        <v-btn
          icon="mdi-chevron-right"
          variant="text"
          size="small"
          density="comfortable"
          :disabled="wrap || edges.atEnd"
          @click="scrollRow(1)"
        />
      </div>
    </div>
    <div ref="row" class="card-shelf__row" :class="{ 'card-shelf__row--wrap': wrap }">
      <slot />
    </div>
  </section>
</template>

<script lang="ts">
import { observeShelfEdges, SHELF_EDGES_UNMEASURED } from './shelfScrollEdges'

export default {
  name: 'CardShelf',
  props: {
    title: { type: String, required: true },
    // Lays the cards out as a wrapping grid instead of one scrolling row —
    // the same cards either way, so a host can offer this as a view toggle
    // (see FavoritesView.vue) without swapping components.
    wrap: { type: Boolean, default: false },
    // Renders the toggle for `wrap` in this shelf's own header, so each
    // shelf is switched on its own rather than a page-level control moving
    // all of them at once. Opt-in: a shelf whose host has no intention of
    // switching it (the Home view's own) shouldn't grow a dead button.
    wrapToggle: { type: Boolean, default: false },
  },
  emits: ['update:wrap'],
  data() {
    return {
      edges: { ...SHELF_EDGES_UNMEASURED },
      edgeWatch: null as ReturnType<typeof observeShelfEdges> | null,
      edgeWatchEl: null as HTMLElement | null,
    }
  },
  mounted() {
    this.syncEdgeWatch()
  },
  updated() {
    this.syncEdgeWatch()
  },
  beforeUnmount() {
    this.edgeWatch?.stop()
  },
  methods: {
    /** (Re)points the edge watch at whichever row is on screen now — the
     * element changes when a shelf swaps its placeholders for real cards,
     * and disappears entirely while there is nothing to show. */
    syncEdgeWatch(): void {
      const row = (this.$refs.row as HTMLElement | undefined) ?? null
      if (row === this.edgeWatchEl) {
        this.edgeWatch?.refresh()
        return
      }
      this.edgeWatch?.stop()
      this.edgeWatchEl = row
      if (!row) {
        this.edgeWatch = null
        this.edges = { ...SHELF_EDGES_UNMEASURED }
        return
      }
      this.edgeWatch = observeShelfEdges(row, (edges) => {
        this.edges = edges
      })
    },

    /** The scrolling row itself, for a host that needs to measure how many
     * cards fit across it (see cardRowFit.ts). Handed out rather than
     * measured through the host's own $el, because a shelf whose template
     * leads with a comment is a *fragment* — its $el is that comment node,
     * which has no width to read and would silently leave the host on its
     * default count (SimilarArtistsShelf.vue is exactly that shape). */
    rowElement(): HTMLElement | null {
      return (this.$refs.row as HTMLElement | undefined) ?? null
    },
    /** One "page" per click, deliberately short of a full width so the card
     * at the edge stays partly visible as a handle on where you were —
     * same 0.8 factor AlbumShelf.vue and SimilarArtistsShelf.vue use. */
    scrollRow(direction: 1 | -1): void {
      const row = this.$refs.row as HTMLElement | undefined
      if (!row) return
      row.scrollBy({ left: direction * row.clientWidth * 0.8, behavior: 'smooth' })
    },
  },
}
</script>

<style scoped>
.card-shelf {
  margin-bottom: 40px;
}

.card-shelf__head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 16px;
}

.card-shelf__nav {
  display: flex;
  gap: 2px;
}

.card-shelf__row {
  display: flex;
  gap: 20px;
  overflow-x: auto;
  padding-bottom: 4px;
  scroll-snap-type: x proximity;
}

/* Cards keep their own width instead of being squeezed to fit the row,
 * which is what makes the row scroll at all. */
.card-shelf__row > * {
  flex: 0 0 auto;
  scroll-snap-align: start;
}

.card-shelf__row--wrap {
  flex-wrap: wrap;
  overflow-x: visible;
  /* Scroll snapping is meaningless without a scroll axis, and leaving it
   * on makes the *page's* own vertical scrolling snap in some browsers. */
  scroll-snap-type: none;
}
</style>
