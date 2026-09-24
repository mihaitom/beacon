<template>
  <div class="detail-page" :class="{ 'detail-page--banded': banded }">
    <div class="detail-page__band">
      <!-- The artwork layer, across the top and masked out towards the
       - bottom so the content below sits on the plain surface. `url` is
       - held back (null) until the lookup answers, so the page never shows
       - the fallback and then swaps to a photo. Two layers so a change
       - fades rather than cuts (see services/crossfadeBackdrop.ts). -->
      <template v-if="show">
        <div
          v-for="(layerUrl, index) in layers.urls"
          :key="index"
          class="detail-page__backdrop"
          :class="{
            'detail-page__backdrop--photo': layerIsPhoto[index],
            'detail-page__backdrop--shown': index === layers.active && Boolean(layerUrl),
          }"
          :style="layerUrl ? { backgroundImage: `url(${layerUrl})` } : {}"
        />
        <div class="detail-page__scrim" />
      </template>
      <div class="detail-page__content">
        <slot />
      </div>
    </div>
    <div v-if="$slots.below" class="detail-page__below">
      <slot name="below" />
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { createBackdropLayers, showBackdrop } from '@/services/crossfadeBackdrop'

/**
 * A detail page's backdrop: a Fanart.tv photo shown sharp when there is
 * one, the blurred cover wash otherwise, over a scrim that keeps the header
 * text readable. Shared by ArtistDetailView.vue and AlbumDetailView.vue; the
 * page decides which url to hand in and whether it is a photo (see their
 * own backdropUrl/backdropIsPhoto).
 */
export default {
  name: 'DetailPageBackdrop',
  props: {
    /** The backdrop image, or null while it is still being resolved. */
    url: { type: String as PropType<string | null>, default: null },
    /** Whether `url` is a full-size Fanart.tv photo (sharp) rather than a
     * cover to blur into a wash. */
    isPhoto: { type: Boolean, default: false },
    /** Whether the page's subject has loaded at all - no backdrop is drawn
     * until it has. */
    show: { type: Boolean, default: true },
    /** The album page's arrangement: the page is exactly the window's
     * height, the backdrop spans the header (the default slot) and fades out
     * at its bottom edge, and the #below content (the track list) scrolls
     * on its own under it, so the header stays in view. Without it the band
     * is a fixed height behind all of the content, which the artist page's
     * bio and album shelf can take, and the whole page scrolls. */
    banded: { type: Boolean, default: false },
  },
  data() {
    return {
      layers: createBackdropLayers(),
      // Per layer, since the one fading out may be a photo while the one
      // fading in is a blurred cover, or the other way round.
      layerIsPhoto: [false, false],
    }
  },
  watch: {
    url: {
      immediate: true,
      handler(url: string | null) {
        showBackdrop(this.layers, url)
        this.layerIsPhoto[this.layers.active] = this.isPhoto
      },
    },
  },
}
</script>

<style scoped>
.detail-page__band {
  position: relative;
  /* The photo's fade to the left, eased rather than linear: a straight ramp
   * starts with a visible step in brightness, which reads as a seam. */
  --detail-page-photo-fade: linear-gradient(
    to right,
    transparent 0%,
    rgba(0, 0, 0, 0.06) 8%,
    rgba(0, 0, 0, 0.2) 16%,
    rgba(0, 0, 0, 0.42) 25%,
    rgba(0, 0, 0, 0.68) 35%,
    rgba(0, 0, 0, 0.88) 45%,
    #000 55%
  );
  /* The album page's fade into the track list, eased the same way. */
  --detail-page-banded-fade: linear-gradient(
    to bottom,
    #000 0%,
    #000 35%,
    rgba(0, 0, 0, 0.82) 50%,
    rgba(0, 0, 0, 0.58) 63%,
    rgba(0, 0, 0, 0.34) 75%,
    rgba(0, 0, 0, 0.15) 86%,
    rgba(0, 0, 0, 0.04) 94%,
    transparent 100%
  );
}

.detail-page__backdrop,
.detail-page__scrim {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: min(78vh, 680px);
  pointer-events: none;
}

.detail-page__backdrop {
  background-size: cover;
  background-position: center 22%;
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 42%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 42%, transparent 100%);
  /* Held back until the lookup answers (see the page's backdropUrl), then
   * faded in - so it never shows the cover and swaps to the background. */
  opacity: 0;
  transition: opacity 0.6s ease;
}

.detail-page__backdrop--shown {
  opacity: 1;
}

/* A photo takes a 16:9 area at the right edge rather than the full width,
 * fading out to the left: the page's text column sits on the plain surface
 * instead of on whatever the photo has there, and a band wider than 16:9
 * no longer crops the photo's top and bottom off (heads, mostly). Its width
 * follows the band's height, so a taller band shows a larger photo; below
 * 16:9 it is the full band again. */
.detail-page__backdrop--photo {
  left: auto;
  aspect-ratio: 16 / 9;
  max-width: 100%;
  background-position: center;
  -webkit-mask-image:
    linear-gradient(to bottom, #000 0%, #000 42%, transparent 100%), var(--detail-page-photo-fade);
  mask-image:
    linear-gradient(to bottom, #000 0%, #000 42%, transparent 100%), var(--detail-page-photo-fade);
  -webkit-mask-composite: source-in;
  mask-composite: intersect;
}

/* The window below the app bar and above the player bar. */
.detail-page--banded {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
}

.detail-page--banded .detail-page__band {
  flex: none;
}

.detail-page--banded .detail-page__below {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.detail-page--banded .detail-page__backdrop,
.detail-page--banded .detail-page__scrim {
  height: auto;
  bottom: 0;
}

/* Eased out to nothing by the header's bottom edge, where the track list
 * starts - a linear fade still showed a band of photo there, which read as
 * an edge. */
.detail-page--banded .detail-page__backdrop {
  -webkit-mask-image: var(--detail-page-banded-fade);
  mask-image: var(--detail-page-banded-fade);
}

/* Wider than 16:9 here: the album page's header is shallow enough that a
 * 16:9 photo covers barely half its width and leaves the rest looking
 * empty. The crop costs some of the photo's top and bottom, so it is held
 * towards the top, where the faces usually are. */
.detail-page--banded .detail-page__backdrop--photo {
  aspect-ratio: 2.4 / 1;
  background-position: center 25%;
  -webkit-mask-image: var(--detail-page-banded-fade), var(--detail-page-photo-fade);
  mask-image: var(--detail-page-banded-fade), var(--detail-page-photo-fade);
}

/* A phone stacks the hero's text under the cover, across the full width,
 * so there is no text column to keep clear - the photo keeps all of it. It
 * also has no height to spare for a header that stays put, so the page
 * scrolls as one there. */
@media (max-width: 599px) {
  .detail-page--banded {
    height: auto;
  }

  .detail-page--banded .detail-page__below {
    overflow-y: visible;
  }

  .detail-page__backdrop--photo {
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 42%, transparent 100%);
    mask-image: linear-gradient(to bottom, #000 0%, #000 42%, transparent 100%);
  }

  .detail-page--banded .detail-page__backdrop--photo {
    -webkit-mask-image: var(--detail-page-banded-fade);
    mask-image: var(--detail-page-banded-fade);
  }
}

/* Without a Fanart.tv background the fallback is the blurred cover wash -
 * the app's one backdrop recipe (see docs/styleguide.md). */
.detail-page__backdrop:not(.detail-page__backdrop--photo) {
  filter: blur(38px) saturate(1.4) brightness(0.55);
  transform: scale(1.1);
  transform-origin: top center;
}

/* Keeps the header text readable over a bright background photo, and eases
 * the top edge into the chrome. */
.detail-page__scrim {
  background: linear-gradient(
    to bottom,
    rgba(18, 20, 28, 0.72) 0%,
    rgba(18, 20, 28, 0.3) 38%,
    rgba(18, 20, 28, 0) 100%
  );
}

.detail-page__content,
.detail-page__below {
  position: relative;
  z-index: 1;
}
</style>
