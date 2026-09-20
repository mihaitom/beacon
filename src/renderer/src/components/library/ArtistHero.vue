<template>
  <section class="artist-hero">
    <div v-if="rating !== null || starred !== null" class="artist-hero__controls">
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

    <div class="artist-hero__main">
      <!-- Clickable only when there is a real picture behind it: opening a
       - full-screen view of the fallback icon would be a promise the hero
       - can't keep. -->
      <cover-art
        :cover-art-id="coverArtId"
        :image-url="imageUrl"
        :size="180"
        :fallback-icon="fallbackIcon"
        class="artist-hero__cover cover-shadow"
        :class="{ 'artist-hero__cover--zoomable': hasArtwork }"
        :title="hasArtwork ? $t('library.showArtwork') : undefined"
        @click="showArtwork"
      />
      <div class="artist-hero__info">
        <div v-if="eyebrow" class="eyebrow-label">{{ eyebrow }}</div>
        <!-- Fanart.tv's clear logo when there is one: it *is* the artist's
         - name, drawn, so the plain-text heading steps aside for it (kept
         - for screen readers and the outline via .visually-hidden). -->
        <img v-if="logoUrl" :src="logoUrl" :alt="name" class="artist-hero__logo" />
        <h1 :class="logoUrl ? 'visually-hidden' : 'detail-title artist-hero__name'">
          {{ name }}
        </h1>
        <div v-if="$slots.meta" class="artist-hero__meta">
          <slot name="meta" />
        </div>
        <div v-if="$slots.actions" class="artist-hero__actions">
          <slot name="actions" />
        </div>
      </div>
    </div>

    <!-- Reserved whether or not a bio arrives, so the hero - and everything
     - below it - never shifts when the Wikipedia paragraph loads. -->
    <div class="artist-hero__bio">
      <slot name="description" />
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from './CoverArt.vue'
import { emitter } from '@/emitter'

/**
 * The artist page's own header, deliberately not DetailHeader.vue: an
 * artist is the one subject with a Wikipedia paragraph, a Fanart.tv clear
 * logo and a per-artist page backdrop, and those pull the layout in a
 * direction the album/playlist headers do not share. The page supplies the
 * backdrop (ArtistDetailView.vue); this is only the arrangement on top of
 * it.
 */
export default {
  name: 'ArtistHero',
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
.artist-hero {
  position: relative;
  margin-bottom: 28px;
}

.artist-hero__controls {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 4px;
}

.artist-hero__main {
  display: flex;
  align-items: flex-end;
  gap: 28px;
}

.artist-hero__cover {
  flex-shrink: 0;
}

.artist-hero__cover--zoomable {
  cursor: zoom-in;
}

.artist-hero__info {
  min-width: 0;
  padding-bottom: 4px;
}

/* Constrained by height rather than width: clear logos vary wildly in
 * aspect, and what has to stay put is how much of the hero they take. */
.artist-hero__logo {
  display: block;
  max-height: 84px;
  max-width: min(100%, 560px);
  object-fit: contain;
  object-position: left center;
  margin: 2px 0 8px;
}

.artist-hero__name {
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artist-hero__meta {
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.8125rem;
}

.artist-hero__actions {
  margin-top: 16px;
}

/* Roughly the clamped bio (three lines) plus its footer links - see
 * ArtistBio.vue. Empty for an artist with no article, which is the price of
 * a hero that never moves. */
.artist-hero__bio {
  min-height: 6.5rem;
  margin-top: 16px;
}

/* A phone has no room for cover and text side by side. */
@media (max-width: 599px) {
  .artist-hero__main {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }
}
</style>
