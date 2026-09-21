<template>
  <div class="now-playing__art-wrap" :class="{ 'now-playing__art-wrap--compact': compact }">
    <div class="now-playing__art-glow" :style="{ background: glowColor }" />
    <cover-art v-if="song" :cover-art-id="song.coverArtId" :size="artSize" class="cover-shadow" />
    <!-- No cover-shadow/card background for a transparent icon (see
     - radioIconIsTransparent) — a real card treatment around a logo that's
     - just floating on transparency looks like a broken image rather than a
     - clean logo. -->
    <cover-art
      v-else
      contain
      :radio-favicon="radioFavicon"
      :size="artSize"
      fallback-icon="mdi-radio"
      :class="radioIconIsTransparent ? 'radio-cover-art--transparent' : 'cover-shadow'"
      @transparency="radioIconIsTransparent = $event"
    />
  </div>
</template>

<script lang="ts">
import CoverArt from '@/components/library/CoverArt.vue'
import type { RadioFaviconRequest } from '@/services/connect/radio'
import type { Song } from '@/types/library'

export default {
  name: 'NowPlayingArtwork',
  components: { CoverArt },
  props: {
    /** The current song, or null for radio (which shows the station logo). */
    song: {
      type: Object as () => Song | null,
      default: null,
    },
    radioFavicon: {
      type: Object as () => RadioFaviconRequest | null,
      default: null,
    },
    /** A CSS size string from the parent's own artSize — a plain CSS value
     * cannot read a component's computed prop, so it is passed down. */
    artSize: {
      type: String,
      required: true,
    },
    glowColor: {
      type: String,
      required: true,
    },
    compact: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      // Reported by <cover-art> once the logo has actually arrived and the
      // backend's own reading of it came with it — false (normal card
      // treatment) until then, so there's no flash of the transparent-icon
      // styling before the icon itself has even loaded.
      radioIconIsTransparent: false,
    }
  },
  watch: {
    // A different station's logo is a different shape — drop the previous
    // one's treatment the moment the station changes, rather than carrying
    // it until the new logo arrives and <cover-art> reports its own.
    radioFavicon() {
      this.radioIconIsTransparent = false
    },
  },
}
</script>

<style scoped>
.now-playing__art-wrap {
  position: relative;
  margin-bottom: 40px;
}

.now-playing__art-wrap--compact {
  margin-bottom: 16px;
}

.now-playing__art-glow {
  position: absolute;
  inset: -70px;
  border-radius: 50%;
  filter: blur(60px);
  transition: background 1.2s ease;
  z-index: 0;
}

.now-playing__art-wrap :deep(.cover-art) {
  position: relative;
  z-index: 1;
}

/* Applied instead of cover-shadow once the loaded favicon has arrived and
 * <cover-art> reported it meaningfully transparent (the backend measures
 * it, see routes/radio.py's _has_transparency) — drops CoverArt.vue's own
 * default card background (a faint white tint meant for genuinely art-less
 * placeholders) too, so a logo that's just floating on transparency shows
 * as exactly that instead of getting boxed in a card whose background
 * shows through the transparent parts as a muddy tint, with a drop shadow
 * around an edge that was never actually there.
 *
 * .radio-cover-art--transparent.cover-art (compound, not just the one
 * class) is deliberate — CoverArt.vue's own scoped background rule targets
 * .cover-art alone, so at equal specificity the one that happens to be
 * later in the built CSS wins, not necessarily this one. Matching both
 * classes outranks it regardless of build order. */
.radio-cover-art--transparent.cover-art {
  background: transparent;
}
</style>
