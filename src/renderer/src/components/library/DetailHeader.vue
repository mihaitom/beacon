<template>
  <section class="detail-header" :class="{ 'detail-header--text-only': !hasArtwork }">
    <!-- Two stacked layers so navigating from one album/artist to the next
     - crossfades the artwork behind the header instead of cutting to it —
     - see services/crossfadeBackdrop.ts for why one element can't do this. -->
    <div
      v-for="(url, i) in backdrop.urls"
      :key="i"
      class="detail-header__backdrop"
      :class="{
        'detail-header__backdrop--active': i === backdrop.active,
        'detail-header__backdrop--photo': layerKind[i] === 'photo',
        'detail-header__backdrop--banner': layerKind[i] === 'banner',
      }"
      :style="url ? { backgroundImage: `url(${url})` } : {}"
    />
    <div
      class="detail-header__scrim"
      :class="{ 'detail-header__scrim--photo': layerKind[backdrop.active] !== 'cover' }"
    />
    <div v-if="starred !== null || $slots['top-right']" class="detail-header__top-right">
      <!-- Its own row, separate from the #top-right slot below — rating/
       - heart are icon-sized controls that always belong together on one
       - line; slot content (an artist page's external-link icons, a
       - playlist's edit/delete buttons) is a different, often wider group
       - that reads better stacked under them than crammed onto the same
       - line. v-if guards it so an empty row (e.g. a playlist, which has
       - neither) doesn't reserve a gap for nothing. -->
      <div v-if="rating !== null || starred !== null" class="detail-header__top-right-row">
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
      </div>
      <div v-if="$slots['top-right']" class="detail-header__top-right-row">
        <slot name="top-right" />
      </div>
    </div>
    <div class="detail-header__content">
      <!-- Only when there is a real picture: a list page has none, and a
       - square holding nothing but a generic icon takes room from the
       - title without saying anything. The icon remains for a picture that
       - fails to load. -->
      <cover-art
        v-if="hasArtwork"
        :cover-art-id="coverArtId"
        :image-url="imageUrl"
        :size="size"
        :fallback-icon="fallbackIcon"
        :rounded="rounded"
        class="detail-header__cover detail-header__cover--zoomable cover-shadow"
        :title="$t('library.showArtwork')"
        @click="showArtwork"
      />
      <div class="detail-header__info min-width-0">
        <div v-if="eyebrow" class="eyebrow-label detail-header__eyebrow">{{ eyebrow }}</div>
        <h1 class="detail-title detail-header__title">{{ title }}</h1>
        <div v-if="$slots.subtitle" class="detail-header__subtitle">
          <slot name="subtitle" />
        </div>
        <div v-if="$slots.meta" class="detail-header__meta">
          <slot name="meta" />
        </div>
        <slot name="description" />
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
import { emitter } from '@/emitter'
import { createBackdropLayers, showBackdrop } from '@/services/crossfadeBackdrop'
import { getStoredImages } from '@/services/connect/fanart'
import { preloadImage } from '@/services/preloadImage'
import { useFanartStore } from '@/stores/fanart'

// How long each stored Fanart.tv background stays before the next one fades
// in - slow enough to read as a calm backdrop rather than a slideshow.
const STORED_FANART_INTERVAL_MS = 12_000

/** A stored Fanart.tv banner across the whole card, a stored background
 * photo at its right edge, or the page's own blurred cover. */
type BackdropKind = 'banner' | 'photo' | 'cover'

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
    /** For a list page with no picture of its own: cycle through the Fanart.tv
     * banners (or, until there are some, backgrounds) connect has already
     * stored - every artist's (true), or only these artists' (a genre's).
     * Nothing new is downloaded for it. */
    storedFanart: { type: [Boolean, Array] as PropType<boolean | string[]>, default: false },
  },
  emits: ['toggle-star', 'set-rating'],
  data() {
    return {
      backdrop: createBackdropLayers(),
      // Per layer, since Fanart.tv art is shown sharp and a cover blurred.
      layerKind: ['cover', 'cover'] as BackdropKind[],
      photos: [] as string[],
      photoKind: 'banner' as BackdropKind,
      photoIndex: 0,
      cycleTimer: null as ReturnType<typeof setInterval> | null,
    }
  },
  computed: {
    /** What storedFanart asks for, as one value to watch: null for nothing,
     * [] for every artist, or the artists' names. */
    storedFanartRequest(): string[] | null {
      if (!useFanartStore().enabled || this.backdropUrl) return null
      if (this.storedFanart === true) return []
      return Array.isArray(this.storedFanart) && this.storedFanart.length ? this.storedFanart : null
    },
    backdropUrl(): string | null {
      if (this.coverArtId) return useLibraryStore().client().coverArtUrl(this.coverArtId, 300)
      return this.imageUrl
    },
    hasArtwork(): boolean {
      return Boolean(this.coverArtId || this.imageUrl)
    },
  },
  methods: {
    show(url: string | null, kind: BackdropKind): void {
      showBackdrop(this.backdrop, url)
      this.layerKind[this.backdrop.active] = kind
    },
    async loadStoredFanart(request: string[] | null): Promise<void> {
      this.stopCycle()
      this.photos = []
      if (!request) {
        if (!this.backdropUrl) this.show(null, 'cover')
        return
      }
      const stored = await this.fetchStored(request)
      // The page may have moved on, or found a picture of its own, meanwhile.
      if (JSON.stringify(this.storedFanartRequest) !== JSON.stringify(request)) return
      if (!stored.photos.length) return
      this.photos = stored.photos
      this.photoKind = stored.kind
      // Already shuffled by connect, one artist at a time - see stored_images().
      this.photoIndex = 0
      await this.showPhoto(stored.photos[0]!)
      // One picture and no cycling for anyone who has asked for less motion.
      if (
        stored.photos.length < 2 ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ) {
        return
      }
      this.cycleTimer = setInterval(() => void this.nextPhoto(), STORED_FANART_INTERVAL_MS)
    },
    /** Banners are this card's shape; backgrounds only until connect has
     * downloaded some banners (it fetches them with every artist lookup). */
    async fetchStored(request: string[]): Promise<{ photos: string[]; kind: BackdropKind }> {
      const artists = request.length ? request : undefined
      try {
        const banners = await getStoredImages('banner', artists)
        if (banners.length) return { photos: banners, kind: 'banner' }
        return { photos: await getStoredImages('background', artists), kind: 'photo' }
      } catch (error) {
        console.error('[detail-header] Stored Fanart.tv images lookup failed:', error)
        return { photos: [], kind: 'banner' }
      }
    },
    async nextPhoto(): Promise<void> {
      // Nobody is looking at a hidden tab; the next tick tries again.
      if (document.hidden || !this.photos.length) return
      this.photoIndex += 1
      if (this.photoIndex >= this.photos.length) {
        // A fresh deal from connect for each round, rather than the same
        // order again - reshuffled here, it would lose connect's one artist
        // at a time.
        const request = this.storedFanartRequest
        const stored = request ? await this.fetchStored(request) : null
        if (JSON.stringify(this.storedFanartRequest) !== JSON.stringify(request)) return
        if (stored?.photos.length) {
          this.photos = stored.photos
          this.photoKind = stored.kind
        }
        this.photoIndex = 0
      }
      await this.showPhoto(this.photos[this.photoIndex]!)
    },
    /** Preloaded first, so the crossfade has an image to fade to (see
     * services/preloadImage.ts). */
    async showPhoto(url: string): Promise<void> {
      const photos = this.photos
      await preloadImage(url)
      if (this.photos !== photos) return
      this.show(url, this.photoKind)
    },
    stopCycle(): void {
      if (this.cycleTimer) clearInterval(this.cycleTimer)
      this.cycleTimer = null
    },
    /** Opens the app-wide viewer (ArtworkLightbox.vue, mounted in App.vue)
     * rather than a dialog of this component's own — this header is on five
     * different pages, and the same picture is also opened from places that
     * have no header at all (a song row's context menu). */
    showArtwork(): void {
      emitter.emit('showArtwork', {
        coverArtId: this.coverArtId,
        imageUrl: this.imageUrl,
        title: this.title,
        subtitle: this.eyebrow || undefined,
        rounded: this.rounded,
        fallbackIcon: this.fallbackIcon,
      })
    },
  },
  watch: {
    // immediate — the first header should fade its artwork in rather than
    // staying blank until some *later* navigation changes it.
    backdropUrl: {
      immediate: true,
      handler(url: string | null) {
        if (!url && this.photos.length) return
        this.show(url, 'cover')
      },
    },
    storedFanartRequest: {
      immediate: true,
      handler(request: string[] | null, previous: string[] | null | undefined) {
        // A genre's artists arrive as a fresh array on every re-render of
        // the page; the same names are no reason to start over.
        if (JSON.stringify(request) === JSON.stringify(previous)) return
        void this.loadStoredFanart(request)
      },
    },
  },
  beforeUnmount() {
    this.stopCycle()
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
  /* Two stacked instances, one --active at a time — this opacity
   * transition is the crossfade itself. Same 0.6s as HeroBand.vue and
   * NowPlayingView.vue, so every backdrop in the app fades at one speed. */
  opacity: 0;
  transition: opacity 0.6s ease;
}

.detail-header__backdrop--active {
  opacity: 1;
}

/* A stored Fanart.tv background (see storedFanart), until connect has
 * banners: like the banner below - the card's full height, held to its
 * right edge, eased out to the left - but at its own 16:9, so nothing of
 * it is cropped; the card is shallow, so it takes a narrow strip at the
 * right. */
.detail-header__backdrop--photo {
  inset: 1px;
  border-radius: 15px;
  background-size: auto 100%;
  background-position: right center;
  background-repeat: no-repeat;
  filter: none;
  transform: none;
  -webkit-mask: var(--beacon-photo-fade) right center / auto 100% no-repeat;
  mask: var(--beacon-photo-fade) right center / auto 100% no-repeat;
}

/* A Fanart.tv banner: always the card's full height and held to its right
 * edge, so a wide window never crops its top and bottom off. Where the card
 * is wider than the banner, it eases out to the left (--beacon-banner-fade
 * in base.css); where it is narrower, its left end is cut off under the
 * scrim. Kept 1px off the card's edge, with its own rounding: every layer
 * is clipped to the card's corners separately, and in the anti-aliased
 * edge pixels the scrim only partly covers a banner reaching them - a
 * light rim round the corners. */
.detail-header__backdrop--banner {
  inset: 1px;
  border-radius: 15px;
  background-size: auto 100%;
  background-position: right center;
  background-repeat: no-repeat;
  filter: none;
  transform: none;
  -webkit-mask: var(--beacon-banner-fade) right center / auto 100% no-repeat;
  mask: var(--beacon-banner-fade) right center / auto 100% no-repeat;
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

/* Over a stored Fanart.tv photo the scrim ends neutral rather than in the
 * amber wash: tinting a sharp photo reads as a colour cast, where over the
 * blurred cover it reads as the app's own light. */
.detail-header__scrim--photo {
  background:
    linear-gradient(
      120deg,
      rgba(18, 20, 28, 0.94) 0%,
      rgba(18, 20, 28, 0.7) 40%,
      rgba(18, 20, 28, 0) 75%
    ),
    linear-gradient(to top, rgba(18, 20, 28, 0.55), transparent 55%);
}

.detail-header__top-right {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.detail-header__top-right-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.detail-header__content {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 28px;
  padding: 48px 32px 32px;
}

/* Centred rather than bottom-aligned with the text: once the text column
 * is the taller one (an artist's Wikipedia paragraph), the picture would
 * otherwise sink to the header's bottom edge. */
.detail-header__cover {
  flex-shrink: 0;
  align-self: center;
}

.detail-header__cover--zoomable {
  cursor: zoom-in;
}

.detail-header__title {
  margin-bottom: 6px;
}

/* No picture beside the text (a list page): the text centres in the card
 * the way the cover would, and the title grows to carry the card on its
 * own - up to the album page's name (DetailHero.vue), but always above
 * the usual 2.25rem, which the window-width part alone only passes on a
 * wide window. */
.detail-header--text-only .detail-header__content {
  min-height: 280px;
  align-items: center;
  padding: 32px;
}

.detail-header--text-only .detail-header__title {
  font-size: clamp(2.75rem, 3.2vw, 3.5rem);
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

/* One line each — the name of an album or artist has no length limit,
 * and this header is a fixed band. */
.detail-header__title,
.detail-header__subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-header__eyebrow {
  margin-bottom: 4px;
}
</style>
