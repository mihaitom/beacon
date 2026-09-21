<template>
  <!-- Full-bleed blurred artwork behind everything — the app's one backdrop
   - recipe, shared with DetailHeader.vue, HeroBand.vue and SongInfoDialog.vue
   - (see docs/styleguide.md). Two stacked layers so a song change crossfades
   - between cover arts — see services/crossfadeBackdrop.ts for why one
   - element can't do this. -->
  <div
    v-for="(url, i) in layers.urls"
    :key="i"
    class="now-playing__backdrop"
    :class="{
      'now-playing__backdrop--active': i === layers.active,
      'now-playing__backdrop--artist': isArtist,
    }"
    :style="url ? { backgroundImage: `url(${url})` } : {}"
  />
  <div class="now-playing__scrim" :style="scrimStyle" />
</template>

<script lang="ts">
import {
  createBackdropLayers,
  showBackdrop,
  type BackdropLayers,
} from '@/services/crossfadeBackdrop'

export default {
  name: 'NowPlayingBackdrop',
  props: {
    /** What the backdrop shows: the artist's Fanart.tv background when there
     * is one, else the blurred cover art. Null for radio. */
    source: {
      type: String as () => string | null,
      default: null,
    },
    /** A Fanart.tv artist background is a full-size photo, so it is shown
     * sharp instead of as a blurred wash of a small cover — the one
     * deliberate exception to the backdrop recipe. */
    isArtist: {
      type: Boolean,
      default: false,
    },
    /** The ambient wash's own gradient, set inline since it depends on the
     * song's extracted colour. */
    scrimStyle: {
      type: Object as () => Record<string, string>,
      required: true,
    },
  },
  data() {
    return {
      layers: createBackdropLayers() as BackdropLayers,
    }
  },
  watch: {
    // A song change may fade twice (cover first, then the artist image once
    // it arrives); that reads as the artist image easing in, not a flicker.
    source: {
      immediate: true,
      handler(url: string | null) {
        showBackdrop(this.layers, url)
      },
    },
  },
}
</script>

<style scoped>
/* Oversized and scaled so the blur radius never reveals a hard edge at the
 * bounds; at this blur the scale alone already covers far more than the
 * radius needs on a full-bleed surface, which is why the inset is the same
 * modest -20px as everywhere else. */
.now-playing__backdrop {
  position: absolute;
  inset: -20px;
  background-size: cover;
  background-position: center;
  filter: blur(38px) saturate(1.4) brightness(0.55);
  transform: scale(1.15);
  /* Two stacked instances of this, only one of which is --active
   * (opacity: 1) at a time — this opacity transition is what actually
   * crossfades between them on a song change (see
   * services/crossfadeBackdrop.ts). Same 0.6s as DetailHeader.vue and
   * HeroBand.vue, so every backdrop in the app fades at one speed. */
  opacity: 0;
  transition: opacity 0.6s ease;
}

.now-playing__backdrop--active {
  opacity: 1;
}

/* See the isArtist prop. The ambient scrim above still tints it for
 * legibility. */
.now-playing__backdrop--artist {
  inset: 0;
  filter: none;
  transform: none;
}

.now-playing__scrim {
  position: absolute;
  inset: 0;
  /* Ambient color is set inline (:style) since it depends on the song;
   * the transition is what makes it change *into* the new color smoothly
   * on a song change instead of snapping. */
  transition: background 1.2s ease;
}
</style>
