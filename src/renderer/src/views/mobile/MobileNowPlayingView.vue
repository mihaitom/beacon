<template>
  <div class="mobile-now-playing">
    <div class="mobile-now-playing__art">
      <now-playing-view compact />
    </div>
    <mobile-transport-controls />
  </div>
</template>

<script lang="ts">
// Reuses NowPlayingView.vue as-is (cover art, title/artist, visualizer,
// lyrics) rather than forking it — its layout is already flexible (no fixed
// widths/hover-only affordances, see the mobile plan's reusability
// research), so only the transport controls below it need a mobile-specific
// build (PlayerBar.vue's own layout is desktop-fixed-width, its store calls
// aren't — see MobileTransportControls.vue).
import NowPlayingView from '@/views/NowPlayingView.vue'
import MobileTransportControls from '@/components/mobile/MobileTransportControls.vue'

export default {
  name: 'MobileNowPlayingView',
  components: { NowPlayingView, MobileTransportControls },
}
</script>

<style scoped>
/* Explicit height computed from the real viewport, not fill-height's
 * percentage-height chain (router-view -> v-main -> this) — see
 * NowPlayingView.vue's own .now-playing comment for the actual mechanism:
 * Vuetify's .v-main is flex-shrink: 0 inside a .v-application__wrap that's
 * only min-height (never a hard max), so "100%" of that chain was never a
 * real cap, just auto-by-another-name. --v-layout-top/--v-layout-bottom are
 * the live pixel heights Vuetify's own layout system already tracks for
 * the app-bar/tab-bar/mini-player-bar registered around this. Clipping via
 * overflow: hidden is the safe outcome either way — unlike Queue/Tracks/
 * Playlists, Now Playing was never meant to scroll at all. */
.mobile-now-playing {
  height: calc(100dvh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
  overflow: hidden;
  /* Grid, not flex — see NowPlayingView.vue's own .now-playing comment for
   * why: minmax(0, 1fr) for the art row (shrinkable below its content's
   * natural size, unlike a plain flex-grow item without an explicit
   * min-height: 0 override) and auto for MobileTransportControls.vue below
   * it, sized to its own content. */
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
}

.mobile-now-playing__art {
  min-height: 0;
  overflow: hidden;
}
</style>
