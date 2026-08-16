<template>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" class="jellyfin-icon">
    <defs>
      <linearGradient id="jellyfin-icon-gradient" gradientUnits="userSpaceOnUse" x1="110.25" y1="213.3" x2="496.14" y2="436.09">
        <stop offset="0" stop-color="#AA5CC3" />
        <stop offset="1" stop-color="#00A4DC" />
      </linearGradient>
    </defs>
    <path
      fill="url(#jellyfin-icon-gradient)"
      d="M256,201.6c-20.4,0-86.2,119.3-76.2,139.4s142.5,19.9,152.4,0S276.5,201.6,256,201.6z"
    />
    <path
      fill="url(#jellyfin-icon-gradient)"
      d="M256,23.3c-61.6,0-259.8,359.4-229.6,420.1s429.3,60,459.2,0S317.6,23.3,256,23.3z M406.5,390.8c-19.6,39.3-281.1,39.8-300.9,0s110.1-275.3,150.4-275.3S426.1,351.4,406.5,390.8z"
    />
  </svg>
</template>

<script lang="ts">
/**
 * Official mark (Jellyfin project's own brand assets, CC BY-SA 4.0), not
 * currentColor — this and its siblings (NavidromeIcon, PlexIcon) are
 * meant to show each service's own real brand identity on the login
 * screen's server-type tiles, not adapt to surrounding UI color the way
 * AirplayIcon.vue's glyph does. "Locked" (not yet selectable) is
 * expressed by the tile dimming/desaturating this via CSS, not by
 * changing the fill itself.
 */
export default {
  name: 'JellyfinIcon',
}
</script>

<style scoped>
.jellyfin-icon {
  width: 1em;
  height: 1em;
  font-size: inherit;
  flex-shrink: 0;
}
</style>
