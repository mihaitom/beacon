<template>
  <div class="detail-page" :class="{ 'detail-page--short': short }">
    <!-- The page-wide artwork layer, full-bleed across the top and masked
     - out towards the bottom so the content below sits on the plain
     - surface. `url` is held back (null) until the lookup answers, so the
     - page never shows the fallback and then swaps to a photo. -->
    <template v-if="show">
      <div
        class="detail-page__backdrop"
        :class="{
          'detail-page__backdrop--photo': isPhoto,
          'detail-page__backdrop--shown': Boolean(url),
        }"
        :style="url ? { backgroundImage: `url(${url})` } : {}"
      />
      <div class="detail-page__scrim" />
    </template>
    <div class="detail-page__content">
      <slot />
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'

/**
 * A detail page's full-bleed backdrop: a Fanart.tv photo shown sharp when
 * there is one, the blurred cover wash otherwise, over a scrim that keeps
 * the header text readable. Shared by ArtistDetailView.vue and
 * AlbumDetailView.vue; the page decides which url to hand in and whether it
 * is a photo (see their own backdropUrl/backdropIsPhoto).
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
    /** A shallower band that fades out above the content (the album page's
     * track list) rather than running behind it the way the artist page's
     * bio and album shelf can take. */
    short: { type: Boolean, default: false },
  },
}
</script>

<style scoped>
.detail-page {
  position: relative;
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

/* The album page's track list begins right under the hero, so its backdrop
 * is a shorter band that has already faded out by the time the rows start -
 * the full-height version would sit behind them and make them unreadable.
 * The album page pushes its track list down (see AlbumDetailView.vue) so
 * this band can still run most of the way past the hero. */
.detail-page--short .detail-page__backdrop,
.detail-page--short .detail-page__scrim {
  height: min(50vh, 440px);
}

.detail-page--short .detail-page__backdrop {
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 18%, transparent 72%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 18%, transparent 72%);
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

.detail-page__content {
  position: relative;
  z-index: 1;
}
</style>
