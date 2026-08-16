<template>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="700 88 303 281" class="plex-icon">
    <g transform="scale(6.7567568)">
      <polygon fill="#EBAF00" points="117.9,33.9 104.1,13.5 118.3,13.5 132,33.9 118.3,54.2 104.1,54.2" />
      <polygon fill="#000000" points="135.7,31.6 148,13.5 133.8,13.5 128.7,21" />
    </g>
  </svg>
</template>

<script lang="ts">
/**
 * Official mark (Plex's own 2022 rebrand SVG, plex.tv brand assets) — the
 * two <polygon>s and their scale transform are untouched from the
 * original file; only the outer viewBox was narrowed, cropping to just
 * this arrow symbol's own bounding box (the original file also ships a
 * "PLEX" wordmark alongside it, sized for a wide banner rather than a
 * square tile). See JellyfinIcon.vue's comment for why this uses fixed
 * brand colors rather than currentColor.
 */
export default {
  name: 'PlexIcon',
}
</script>

<style scoped>
.plex-icon {
  width: 1em;
  height: 1em;
  font-size: inherit;
  flex-shrink: 0;
}
</style>
