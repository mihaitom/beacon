<template>
  <section class="detail-hero" :class="{ 'detail-hero--large': large }">
    <div
      v-if="rating !== null || starred !== null || $slots.controls"
      class="detail-hero__controls"
    >
      <!-- A page's own controls for its backdrop (the artist page's
       - background cycle button), ahead of the rating. -->
      <slot name="controls" />
      <v-rating
        v-if="rating !== null"
        :model-value="rating"
        length="5"
        size="large"
        density="compact"
        active-color="primary"
        hover
        clearable
        @update:model-value="$emit('set-rating', $event)"
      />
      <v-btn
        v-if="starred !== null"
        :icon="starred ? 'mdi-heart' : 'mdi-heart-outline'"
        :color="starred ? 'primary' : undefined"
        variant="text"
        :title="$t(starred ? 'library.unstar' : 'library.star')"
        @click="$emit('toggle-star')"
      />
    </div>

    <div class="detail-hero__main">
      <!-- Clickable only when there is a real picture behind it: opening a
       - full-screen view of the fallback icon would be a promise the hero
       - can't keep. -->
      <cover-art
        :cover-art-id="coverArtId"
        :image-url="imageUrl"
        :size="coverSize"
        :fallback-icon="fallbackIcon"
        class="detail-hero__cover cover-shadow"
        :class="{ 'detail-hero__cover--zoomable': hasArtwork }"
        :title="hasArtwork ? $t('library.showArtwork') : undefined"
        @click="showArtwork"
      />
      <div class="detail-hero__info">
        <div v-if="eyebrow" class="eyebrow-label">{{ eyebrow }}</div>
        <!-- Fanart.tv's clear logo when there is one: it *is* the artist's
         - name, drawn, so the plain-text heading steps aside for it (kept
         - for screen readers and the outline via .visually-hidden). -->
        <img v-if="logoUrl" :src="logoUrl" :alt="name" class="detail-hero__logo" />
        <h1 :class="logoUrl ? 'visually-hidden' : 'detail-title detail-hero__name'">
          {{ name }}
        </h1>
        <div v-if="$slots.subtitle" class="detail-hero__subtitle">
          <slot name="subtitle" />
        </div>
        <div v-if="$slots.meta" class="detail-hero__meta">
          <slot name="meta" />
        </div>
        <!-- Small facts that are not a sentence (the album page's label,
         - edition, reissue year), under the meta line. -->
        <div v-if="$slots.tags" class="detail-hero__tags">
          <slot name="tags" />
        </div>
        <!-- The large variant keeps its paragraph in this column, beside
         - the cover, rather than under the whole hero. -->
        <slot v-if="large" name="description" />
        <div v-if="$slots.actions" class="detail-hero__actions">
          <slot name="actions" />
        </div>
      </div>
    </div>

    <!-- Only when the page actually passes one (the artist page's Wikipedia
     - paragraph). Rendering an empty wrapper for a page with no such slot
     - would reserve a paragraph's height for nothing. -->
    <div v-if="$slots.description && !large" class="detail-hero__bio">
      <slot name="description" />
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from './CoverArt.vue'
import { emitter } from '@/emitter'

/**
 * The shared header for a detail page (artist, album) — the arrangement of
 * cover, name, meta and actions that sits on top of the page's own
 * full-bleed backdrop (DetailPageBackdrop.vue). An artist is the one subject
 * with a Wikipedia paragraph and a Fanart.tv clear logo, both of which this
 * renders through its #description/#logoUrl when a page supplies them.
 */
export default {
  name: 'DetailHero',
  components: { CoverArt },
  props: {
    name: { type: String, required: true },
    eyebrow: { type: String, default: '' },
    coverArtId: { type: String as PropType<string | null>, default: null },
    imageUrl: { type: String as PropType<string | null>, default: null },
    /** Fanart.tv's HD clear logo, or null - see the template. */
    logoUrl: { type: String as PropType<string | null>, default: null },
    fallbackIcon: { type: String, default: 'mdi-account-music' },
    /** The cover's edge: pixels, or a CSS length (the album page sizes it
     * from the window's height). */
    coverSize: { type: [Number, String] as PropType<number | string>, default: 180 },
    /** The album page's header: a cover as tall as the header it sits in,
     * a display-size name that may take two lines, and no gap below - the
     * page's own track list starts under it. */
    large: { type: Boolean, default: false },
    starred: { type: Boolean as PropType<boolean | null>, default: null },
    rating: { type: Number as PropType<number | null>, default: null },
  },
  emits: ['toggle-star', 'set-rating'],
  computed: {
    hasArtwork(): boolean {
      return Boolean(this.coverArtId || this.imageUrl)
    },
  },
  methods: {
    /** Opens the app-wide viewer (ArtworkLightbox.vue, mounted in App.vue)
     * rather than a dialog of this component's own, the same as every other
     * header's artwork. */
    showArtwork(): void {
      if (!this.hasArtwork) return
      emitter.emit('showArtwork', {
        coverArtId: this.coverArtId,
        imageUrl: this.imageUrl,
        title: this.name,
        subtitle: this.eyebrow || undefined,
        fallbackIcon: this.fallbackIcon,
      })
    },
  },
}
</script>

<style scoped>
.detail-hero {
  position: relative;
  margin-bottom: 28px;
  /* The rating/heart controls get a column of their own rather than lying
   * over the top right corner: over it, a narrow page (a tablet, or the
   * queue drawer open) ran the name in under the stars. */
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
}

.detail-hero__controls {
  grid-column: 2;
  grid-row: 1;
  align-self: start;
  /* A margin rather than a column gap, so a hero without controls keeps
   * its full width. */
  margin-left: 16px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 4px;
}

.detail-hero__main {
  grid-column: 1;
  grid-row: 1;
  display: flex;
  align-items: flex-end;
  gap: 28px;
}

.detail-hero__bio {
  grid-column: 1 / -1;
}

/* At the top rather than the bottom: where the text beside it is the
 * taller of the two (a tablet, with the album's paragraph), a bottom-aligned
 * cover sank a little further with everything that loaded into the text.
 * Where the cover is the taller one, as on a desktop, it is the same place. */
.detail-hero__cover {
  flex-shrink: 0;
  align-self: flex-start;
}

.detail-hero__cover--zoomable {
  cursor: zoom-in;
}

.detail-hero__info {
  min-width: 0;
  padding-bottom: 4px;
}

/* Constrained by height rather than width: clear logos vary wildly in
 * aspect, and what has to stay put is how much of the hero they take. */
.detail-hero__logo {
  display: block;
  max-height: 84px;
  max-width: min(100%, 560px);
  object-fit: contain;
  object-position: left center;
  margin: 2px 0 8px;
}

.detail-hero__name {
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The album page's link to the artist - styled by the page, like
 * DetailHeader's own subtitle slot. */
.detail-hero__subtitle {
  margin-bottom: 4px;
}

.detail-hero__meta {
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.8125rem;
}

.detail-hero__actions {
  margin-top: 16px;
}

.detail-hero__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

/* Roughly the longest bio shown without collapsing (five lines) plus its
 * footer links - see ArtistBio.vue. A page that passes the slot reserves
 * the height, so the hero never shifts when the paragraph loads. */
.detail-hero__bio {
  min-height: 9rem;
  margin-top: 16px;
}

/* Fills whatever height the page gives it, so the cover and the text
 * beside it sit on the header's bottom edge. */
.detail-hero--large {
  flex: 1;
  grid-template-rows: 1fr;
  margin-bottom: 0;
}

.detail-hero--large .detail-hero__main {
  gap: 36px;
}

/* Narrow enough that a long name wraps before it reaches the page's photo
 * backdrop (see DetailPageBackdrop.vue), which starts around the middle of
 * the page; the header has the height for a third line. */
.detail-hero--large .detail-hero__info {
  max-width: 34vw;
}

.detail-hero--large .detail-hero__name {
  font-size: clamp(2rem, 3.2vw, 3.5rem);
  line-height: 1.1;
  margin-bottom: 10px;
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.detail-hero--large .detail-hero__meta {
  font-size: 0.875rem;
}

.detail-hero--large .detail-hero__actions {
  margin-top: 20px;
}

/* A phone has no room for cover and text side by side, nor for the
 * controls beside either: they take a row of their own above. */
@media (max-width: 599px) {
  .detail-hero {
    grid-template-columns: minmax(0, 1fr);
  }

  .detail-hero__controls {
    grid-column: 1;
    justify-self: end;
    margin-left: 0;
  }

  .detail-hero__main {
    grid-column: 1;
    grid-row: 2;
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }
}
</style>
