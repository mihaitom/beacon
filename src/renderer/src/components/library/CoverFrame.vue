<template>
  <v-avatar v-if="rounded" :size="sizeCss" rounded="0">
    <v-img
      v-if="src || lazySrc"
      :src="src ?? undefined"
      :lazy-src="lazySrc"
      width="100%"
      height="100%"
      :cover="!contain"
      eager
      @error="$emit('error')"
    >
      <template #placeholder>
        <!-- Only when there is nothing better to show: with a lazy-src,
           - v-img is already drawing that in this same spot. -->
        <v-skeleton-loader v-if="!lazySrc" type="image" class="cover-art-skeleton" />
      </template>
    </v-img>
    <v-skeleton-loader v-else-if="pending" type="image" class="cover-art-skeleton" />
    <v-icon v-else :size="iconSizeCss(0.6)" :icon="fallbackIcon" />
  </v-avatar>
  <div v-else class="cover-art" :style="{ width: sizeCss, height: sizeCss }">
    <!-- v-img is sized as 100%/100% of this box, not its own copy of `size`
     - in px — a second, independent explicit size wouldn't track a CSS
     - transition put on this box's own width/height (e.g. NowPlayingView's
     - artwork-shrinks-for-lyrics animation): the box would resize smoothly
     - while the image inside it snapped instantly, since nothing here was
     - telling *it* to animate too. Filling the parent means it always
     - matches this box's current size, mid-transition or not. Inside the
     - box rather than above it: a comment between the two branches would
     - make this one a fragment, and CoverArt observes this element. -->
    <v-img
      v-if="src || lazySrc"
      :src="src ?? undefined"
      :lazy-src="lazySrc"
      width="100%"
      height="100%"
      :cover="!contain"
      eager
      @error="$emit('error')"
    >
      <template #placeholder>
        <!-- Same as the rounded branch above. -->
        <v-skeleton-loader v-if="!lazySrc" type="image" class="cover-art-skeleton" />
      </template>
    </v-img>
    <v-skeleton-loader v-else-if="pending" type="image" class="cover-art-skeleton" />
    <div v-else class="cover-art-fallback">
      <v-icon :size="iconSizeCss(0.5)" :icon="fallbackIcon" />
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'

/** How a cover looks: the box, the image, the skeleton while one is on its
 * way and the icon when there is none. Knows nothing about where the image
 * comes from, so the app's batched CoverArt and the party guest page's
 * GuestCover draw the very same thing - the guest bundle must not carry
 * CoverArt's library store, and a second copy of this markup is what kept
 * drifting. */
export default {
  name: 'CoverFrame',
  props: {
    /** The image to show, or null while there is none. */
    src: {
      type: String as PropType<string | null>,
      default: null,
    },
    /** A smaller copy shown until `src` has decoded - see CoverArt's own. */
    lazySrc: {
      type: String,
      default: '',
    },
    /** Still fetching: a skeleton rather than the fallback icon. */
    pending: {
      type: Boolean,
      default: false,
    },
    /** Pixels, or a whole CSS size (e.g. "70vh") used as-is. */
    size: {
      type: [Number, String] as PropType<number | string>,
      default: 160,
    },
    rounded: {
      type: Boolean,
      default: false,
    },
    contain: {
      type: Boolean,
      default: false,
    },
    fallbackIcon: {
      type: String,
      default: 'mdi-album',
    },
  },
  emits: ['error'],
  computed: {
    // This component's own CSS box (width/height, both branches) — a
    // number needs "px" appended, a string (already a full CSS value) is
    // used as-is.
    sizeCss(): string {
      return typeof this.size === 'number' ? `${this.size}px` : this.size
    },
  },
  methods: {
    // Fallback icon's proportional size (0.6 for the rounded avatar
    // variant, 0.5 for the plain box — see the template). CSS calc(),
    // not arithmetic on `size` directly, so this still works when `size`
    // is a viewport-relative string rather than a plain pixel number.
    iconSizeCss(fraction: number): string {
      return typeof this.size === 'number'
        ? `${this.size * fraction}px`
        : `calc(${this.size} * ${fraction})`
    },
  },
}
</script>

<style scoped>
.cover-art {
  border-radius: 4px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.06);
}

.cover-art-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.3);
}

/* Shown for as long as there is no image to show yet — without this, the
 * cover briefly renders empty/transparent between "data arrived" and
 * "image arrived". .v-img__placeholder is already position:absolute +
 * 100%/100%, so this just needs to fill that; the parent (.cover-art or
 * the avatar) already clips to the right shape. */
.cover-art-skeleton {
  width: 100%;
  height: 100%;
  border-radius: 0;
}

.cover-art-skeleton :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}
</style>
