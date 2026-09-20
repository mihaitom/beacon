<template>
  <section class="detail-hero">
    <div v-if="rating !== null || starred !== null" class="detail-hero__controls">
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
        :size="180"
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
        <div v-if="$slots.actions" class="detail-hero__actions">
          <slot name="actions" />
        </div>
      </div>
    </div>

    <!-- Only when the page actually passes one (the artist page's Wikipedia
     - paragraph). Rendering an empty wrapper for a page with no such slot
     - (an album) would reserve a paragraph's height for nothing. -->
    <div v-if="$slots.description" class="detail-hero__bio">
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
}

.detail-hero__controls {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 4px;
}

.detail-hero__main {
  display: flex;
  align-items: flex-end;
  gap: 28px;
}

.detail-hero__cover {
  flex-shrink: 0;
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

/* Roughly the clamped bio (three lines) plus its footer links - see
 * ArtistBio.vue. A page that passes the slot reserves the height, so the
 * hero never shifts when the paragraph loads. */
.detail-hero__bio {
  min-height: 6.5rem;
  margin-top: 16px;
}

/* A phone has no room for cover and text side by side. */
@media (max-width: 599px) {
  .detail-hero__main {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }
}
</style>
