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
        class="mr-1"
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
}
</script>

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
</style>
