<template>
  <v-app>
    <!-- The only way to reach /settings (logout, language, ...) from the
     - mobile shell — none of the five tabs cover it. Shown on every route,
     - including Now Playing, so it doesn't depend on playback state (that
     - view's own toolbar only renders at all once something's playing). -->
    <v-app-bar density="compact" height="44" color="#0B0D13" class="mobile-app-bar">
      <v-icon icon="mdi-lighthouse-on" color="primary" size="16" class="ml-3 mr-2 beacon-glow" />
      <v-app-bar-title class="mobile-app-bar__title">Beacon</v-app-bar-title>
      <v-spacer />
      <v-btn icon="mdi-cog-outline" variant="text" density="comfortable" class="mr-1" @click="$router.push('/settings')" />
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
