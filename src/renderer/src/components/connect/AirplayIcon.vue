<template>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="airplay-icon">
    <path d="M0 0h24v24H0z" fill="none" />
    <path
      fill="currentColor"
      d="M6 22h12l-6-6m9-13H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4v-2H3V5h18v12h-4v2h4a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2"
    />
  </svg>
</template>

<script lang="ts">
/**
 * Material Design Icons has no "airplay" glyph (it won't carry Apple's
 * trademarked logo) — DeviceListItem used mdi-cast-audio as a stand-in
 * until now. This is the real AirPlay glyph, sized/colored like a v-icon
 * (1em box, fill: currentColor) so it drops into the same spot.
 */
export default {
  name: 'AirplayIcon',
}
</script>

<style scoped>
.airplay-icon {
  width: 1em;
  height: 1em;
  font-size: inherit;
  flex-shrink: 0;
}
</style>
