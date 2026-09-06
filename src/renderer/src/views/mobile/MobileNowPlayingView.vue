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
 * the live pixel heights Vuetify's own layout system already songs for
 * the app-bar/tab-bar/mini-player-bar registered around this. Clipping via
 * overflow: hidden is the safe outcome either way — unlike Queue/Songs/
 * Playlists, Now Playing was never meant to scroll at all. */
.mobile-now-playing {
  /* svh, not dvh, plus a plain-vh line under it for engines that know
   * neither.
   *
   * `dvh` is only right if the browser subtracts its own chrome, and not
   * every one does: Orion on iOS reports 100dvh as though its bottom bar
   * (address field plus button row, some 200px) were not there, so this
   * box came out that much taller than the visible area and the page
   * scrolled by exactly that - artwork out of the top, a black band above
   * the tab bar. Safari made the same mistake, small enough to shrug at.
   *
   * `svh` is the smallest viewport height, the one with every dynamic
   * toolbar shown, so it cannot overflow: where a toolbar later hides, a
   * strip of unused space is left rather than the page growing past the
   * screen. That fixed Safari. Orion is unchanged by it - it gets svh
   * wrong the same way - and is deliberately left there: chasing it needs
   * the real height measured through visualViewport in JS, which is a lot
   * of machinery for one uncommon browser. On a desktop window nothing is
   * dynamic and all three units are the same number.
   *
   * Two declarations because an engine that knows neither drops the line
   * entirely and falls back to `auto`, which nothing in the chain above
   * caps - the page then grows to whatever the content needs. */
  height: calc(100vh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
  height: calc(100svh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
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
