<template>
  <v-app>
    <!-- The only way to reach /settings (logout, language, ...) from the
     - mobile shell — none of the five tabs cover it. Shown on every route,
     - including Now Playing, so it doesn't depend on playback state (that
     - view's own toolbar only renders at all once something's playing). -->
    <!-- 56, not the 44 this started at: the bar carries the current view's
       - own actions now (see the actions slot below), and an icon button in
       - a 44px bar sat with barely a pixel of air above and below it.
       -
       - No `density` prop either — Vuetify's compact density overrode the
       - height outright rather than adjusting it, leaving the bar at 41px
       - however large the number here said. -->
    <v-app-bar height="56" color="#0B0D13" class="mobile-app-bar">
      <!-- Same size as every other icon in this bar. It was 16 while the
         - bar held nothing but a title; sitting next to 24px buttons it
         - just read as a small version of them. -->
      <v-icon
        icon="mdi-lighthouse-on"
        color="primary"
        size="24"
        class="mobile-app-bar__logo beacon-glow"
      />
      <v-app-bar-title class="mobile-app-bar__title">Beacon</v-app-bar-title>
      <v-spacer />
      <!-- Where a view can hang its own actions instead of floating them
         - over its content. Now Playing is the one that does (see
         - NowPlayingView.vue's toolbar Teleport): its two buttons used to
         - sit in the top-right corner of the artwork, which only worked
         - while the artwork was small enough to leave a corner free. -->
      <span id="mobile-app-bar-actions" class="mobile-app-bar__actions" />
      <v-btn
        icon="mdi-cog-outline"
        variant="text"
        density="comfortable"
        class="mobile-app-bar__action"
        @click="$router.push('/settings')"
      />
    </v-app-bar>

    <v-main>
      <router-view />
    </v-main>

    <!-- Registration order matters for Vuetify's app-layout stacking —
     - whichever `app` item mounts *first* lands at the true edge (bottom: 0
     - in Vuetify's own generateLayers(), see composables/layout.js), and
     - each one after that stacks further out. mobile-tab-bar has to come
     - first so it's the one actually touching the bottom edge/safe area,
     - with mobile-player-bar's mini strip docking above it — not the other
     - way around. Only shown off the Now Playing tab itself, where the full
     - transport controls already cover the same ground (see
     - MobileNowPlayingView.vue). -->
    <mobile-tab-bar />
    <mobile-player-bar v-if="!onNowPlaying" />
    <cast-takeover-confirm-dialog />
  </v-app>
</template>

<script lang="ts">
import MobileTabBar from '@/components/mobile/MobileTabBar.vue'
import MobilePlayerBar from '@/components/mobile/MobilePlayerBar.vue'
import CastTakeoverConfirmDialog from '@/components/connect/CastTakeoverConfirmDialog.vue'

export default {
  name: 'MobileLayout',
  components: { MobileTabBar, MobilePlayerBar, CastTakeoverConfirmDialog },
  computed: {
    onNowPlaying() {
      return this.$route.name === 'm-now-playing'
    },
  },
  // On <html> rather than in a scoped block: the rules below have to reach
  // the document itself, and only while this shell is the one on screen -
  // the desktop app scrolls its own pages normally.
  mounted() {
    document.documentElement.classList.add('mobile-shell')
  },
  beforeUnmount() {
    document.documentElement.classList.remove('mobile-shell')
  },
}
</script>

<style>
/* The page itself must not scroll on a phone; the content between the two
 * bars does.
 *
 * Every mobile view is a plain block that grows with its content, so the
 * document was the scroller - and the two bars hang off Vuetify's layout
 * with `position: fixed`, which iOS pins to the *layout* viewport rather
 * than to what is on screen. Installed as a PWA that came apart: reported
 * 2026-09-07 as the tab bar travelling up the screen while scrolling and
 * then staying in the middle of it.
 *
 * Nothing here is a workaround for that one browser - a shell with fixed
 * chrome and one scrolling pane between it is what this layout has always
 * meant, and the document scrolling underneath it was accidental. */
html.mobile-shell,
html.mobile-shell body {
  height: 100%;
  overflow: hidden;
}

/* Sticky headers clamp against the pane below, which already starts below
 * the app bar - offsetting them by its height again (the desktop's own
 * --v-layout-top) left a strip above them with rows scrolling through it.
 * See StickyFilter.vue. */
html.mobile-shell {
  --beacon-sticky-top: 0px;
}

/* dvh, with vh under it for engines that know neither: this box sits
 * *between* the bars rather than behind them, so it wants the viewport as
 * it currently is. Where a browser gets dvh wrong the bars stay put
 * regardless - only this pane is then a little too tall or short, which
 * costs a few pixels of scroll rather than the layout. */
html.mobile-shell .v-main {
  height: 100vh;
  height: 100dvh;
  overflow-y: auto;
  /* A flick that reaches the end of the list stays in the list instead of
   * pulling the page behind it. */
  overscroll-behavior: contain;
}
</style>

<style scoped>
.mobile-app-bar__logo {
  margin-inline-start: 12px;
  margin-inline-end: 8px;
}

.mobile-app-bar__actions {
  display: flex;
  align-items: center;
}

.mobile-app-bar {
  border-bottom: 1px solid var(--beacon-hairline);
}

.mobile-app-bar__title {
  font-weight: 600;
  font-size: 0.95rem;
}

.beacon-glow {
  filter: drop-shadow(0 0 6px rgba(245, 169, 78, 0.55));
}

.mobile-app-bar__action {
  margin-right: 4px;
}
</style>
