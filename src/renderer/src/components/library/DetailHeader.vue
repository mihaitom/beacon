<template>
  <section class="detail-header">
    <div class="detail-header__backdrop" :style="backdropStyle" />
    <div class="detail-header__scrim" />
    <div v-if="starred !== null || $slots['top-right']" class="detail-header__top-right">
      <v-rating
        v-if="rating !== null"
        :model-value="rating"
        length="5"
        size="large"
        density="compact"
        active-color="primary"
        hover
        clearable
        class="detail-header__rating"
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
      <slot name="top-right" />
    </div>
    <div class="detail-header__content">
      <cover-art
        :cover-art-id="coverArtId"
        :image-url="imageUrl"
        :size="size"
        :fallback-icon="fallbackIcon"
        :rounded="rounded"
        class="detail-header__cover cover-shadow"
      />
      <div class="detail-header__info min-width-0">
        <div v-if="eyebrow" class="eyebrow-label mb-1">{{ eyebrow }}</div>
        <h1 class="detail-title detail-header__title text-truncate">{{ title }}</h1>
        <div v-if="$slots.subtitle" class="detail-header__subtitle text-truncate">
          <slot name="subtitle" />
        </div>
        <div v-if="$slots.meta" class="detail-header__meta">
          <slot name="meta" />
        </div>
        <div v-if="$slots.actions" class="detail-header__actions">
          <slot name="actions" />
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from './CoverArt.vue'
import { useLibraryStore } from '@/stores/library'

/**
 * Shared "hero" treatment for album/artist/playlist detail pages — a
 * blurred, tinted wash of the item's own art behind the title, the same
 * language HeroBand.vue/NowPlayingView.vue already use elsewhere. Exists
 * specifically to replace the plain "square cover + text beside it" row
 * every detail view used before.
 */
export default {
  name: 'DetailHeader',
  components: { CoverArt },
  props: {
    coverArtId: { type: String as PropType<string | null>, default: null },
    imageUrl: { type: String as PropType<string | null>, default: null },
    size: { type: Number, default: 180 },
    // Optional — omitted on plain browse/list pages (AlbumsView.vue etc.)
    // where the only candidate text was the same word as `title`, just
    // singular ("Album" over "Albums") — pure noise, not information.
    // Still required-in-spirit for detail pages (AlbumDetailView.vue etc.),
    // which pass a real category label above the item's own name.
    eyebrow: { type: String, default: '' },
    title: { type: String, required: true },
    fallbackIcon: { type: String, default: 'mdi-album' },
    rounded: { type: Boolean, default: false },
    // null hides the star button entirely (e.g. playlists, which Subsonic
    // has no starred concept for) — true/false shows it in that state.
    starred: { type: Boolean as PropType<boolean | null>, default: null },
    // null hides the rating widget entirely (e.g. playlists) — 0-5 shows it,
    // 0 meaning "not yet rated" rather than "rated zero stars".
    rating: { type: Number as PropType<number | null>, default: null },
  },
  emits: ['toggle-star', 'set-rating'],
  computed: {
    backdropStyle() {
      const url = this.coverArtId
        ? useLibraryStore().client().coverArtUrl(this.coverArtId, 300)
        : this.imageUrl
      return url ? { backgroundImage: `url(${url})` } : {}
    },
  },
}
</script>

<style scoped>
.detail-header {
  position: relative;
  border-radius: 16px;
  overflow: hidden;
  margin-bottom: 32px;
  min-height: 280px;
  isolation: isolate;
}

.detail-header__backdrop {
  position: absolute;
  inset: -20px;
  background-size: cover;
  background-position: center;
  filter: blur(38px) saturate(1.4) brightness(0.55);
  transform: scale(1.15);
}

.detail-header__scrim {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(
      120deg,
      rgba(18, 20, 28, 0.94) 0%,
      rgba(18, 20, 28, 0.75) 45%,
      rgba(245, 169, 78, 0.2) 100%
    ),
    linear-gradient(to top, rgba(18, 20, 28, 0.55), transparent 55%);
}

.detail-header__top-right {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 2;
  display: flex;
  gap: 4px;
}

.detail-header__content {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 28px;
  padding: 48px 32px 32px;
}

.detail-header__cover {
  flex-shrink: 0;
}

.detail-header__title {
  margin-bottom: 6px;
}

/* No link-hover styling here (color-shift + underline) — this wraps
 * whatever the #subtitle slot is given, and that's plain non-interactive
 * text at one call site (PlaylistDetailView.vue's "by {owner}") and a real
 * router-link at another (AlbumDetailView.vue's artist name). A hover
 * effect here applied to *both* alike, making the plain-text case look
 * clickable when it isn't. Link styling belongs on the link itself — see
 * AlbumDetailView.vue's own .detail-header__subtitle-link. */
.detail-header__subtitle {
  color: rgba(255, 255, 255, 0.75);
  margin-bottom: 4px;
}

.detail-header__rating {
  margin: 6px 20px;
}

.detail-header__meta {
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.8125rem;
}

.detail-header__actions {
  margin-top: 16px;
}

.min-width-0 {
  min-width: 0;
}
</style>
