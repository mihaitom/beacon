<template>
  <v-app>
    <v-navigation-drawer
      v-model="drawerOpen"
      rail
      expand-on-hover
      permanent
      color="#0B0D13"
      class="beacon-rail"
    >
      <v-list density="compact" nav>
        <v-list-item
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          :prepend-icon="item.icon"
          :title="item.title"
        />
      </v-list>

      <template #append>
        <v-list density="compact" nav>
          <v-list-item to="/settings" prepend-icon="mdi-cog" :title="$t('nav.settings')" />
        </v-list>
      </template>
    </v-navigation-drawer>

    <v-app-bar density="comfortable" color="#0B0D13" class="beacon-app-bar">
      <v-icon icon="mdi-lighthouse-on" color="primary" size="20" class="ml-4 mr-2 beacon-glow" />
      <v-app-bar-title class="app-title">Beacon</v-app-bar-title>
      <v-spacer />
      <top-bar-search />
    </v-app-bar>

    <v-main>
      <router-view />
    </v-main>

    <player-bar />
    <!-- Not mounted at all until first opened (see queueDrawerEverOpened/
     - lyricsDrawerEverOpened below) — v-navigation-drawer briefly showed
     - its open position on the very first paint at app start even with
     - model-value already false, before the closed transform took effect.
     - Nothing to flash if it isn't in the DOM yet. Stays mounted for the
     - rest of the session once opened, same "persistent, not temporary"
     - behavior as before either way. -->
    <queue-drawer
      v-if="queueDrawerEverOpened"
      :model-value="playbackStore.queueDrawerOpen"
      @update:model-value="playbackStore.queueDrawerOpen = $event"
    />
    <lyrics-drawer
      v-if="lyricsDrawerEverOpened"
      :model-value="onNowPlaying ? false : playbackStore.lyricsDrawerOpen"
      @update:model-value="playbackStore.lyricsDrawerOpen = $event"
    />
    <cast-takeover-confirm-dialog />
  </v-app>
</template>

<script lang="ts">
import PlayerBar from '@/components/player/PlayerBar.vue'
import QueueDrawer from '@/components/queue/QueueDrawer.vue'
import LyricsDrawer from '@/components/lyrics/LyricsDrawer.vue'
import CastTakeoverConfirmDialog from '@/components/connect/CastTakeoverConfirmDialog.vue'
import TopBarSearch from '@/components/TopBarSearch.vue'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'

export default {
  name: 'DefaultLayout',
  components: {
    PlayerBar,
    QueueDrawer,
    LyricsDrawer,
    CastTakeoverConfirmDialog,
    TopBarSearch,
  },
  data() {
    return {
      drawerOpen: true,
      // Flips true the first time each drawer opens and never resets —
      // see the queue-drawer/lyrics-drawer v-if above for why.
      queueDrawerEverOpened: false,
      lyricsDrawerEverOpened: false,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    authStore() {
      return useAuthStore()
    },
    // NowPlayingView.vue renders lyrics inline (its own split-panel
    // transition) whenever playbackStore.lyricsDrawerOpen is true, driven
    // by the same PlayerBar button as this drawer — without this check
    // both would show at once while on that route, one full-panel and one
    // slid out on top of it.
    onNowPlaying() {
      return this.$route.name === 'now-playing'
    },
    navItems() {
      const capabilities = this.authStore.capabilities
      return [
        { to: '/', icon: 'mdi-home', title: this.$t('nav.home') },
        { to: '/albums', icon: 'mdi-album', title: this.$t('nav.albums') },
        { to: '/artists', icon: 'mdi-account-music', title: this.$t('nav.artists') },
        { to: '/tracks', icon: 'mdi-music-note', title: this.$t('nav.tracks') },
        { to: '/genres', icon: 'mdi-tag-multiple', title: this.$t('nav.genres') },
        { to: '/playlists', icon: 'mdi-playlist-play', title: this.$t('nav.playlists') },
        capabilities.internetRadio
          ? { to: '/radio', icon: 'mdi-radio', title: this.$t('nav.radio') }
          : null,
        capabilities.favorites
          ? { to: '/favorites', icon: 'mdi-heart', title: this.$t('nav.favorites') }
          : null,
        capabilities.playHistoryStats
          ? { to: '/stats', icon: 'mdi-chart-box-outline', title: this.$t('nav.stats') }
          : null,
      ].filter((item): item is { to: string; icon: string; title: string } => item !== null)
    },
  },
  watch: {
    'playbackStore.queueDrawerOpen'(open: boolean) {
      if (open) this.queueDrawerEverOpened = true
    },
    'playbackStore.lyricsDrawerOpen'(open: boolean) {
      if (open) this.lyricsDrawerEverOpened = true
    },
  },
}
</script>

<style scoped>
.app-title :deep(.v-toolbar-title__placeholder) {
  font-weight: 600;
  letter-spacing: 0.04em;
}

.beacon-app-bar {
  border-bottom: 1px solid var(--beacon-hairline);
}

.beacon-glow {
  filter: drop-shadow(0 0 6px rgba(245, 169, 78, 0.55));
}

.beacon-rail {
  border-right: 1px solid var(--beacon-hairline);
}

/* Replaces Vuetify's default flat grey hover/active overlay with the
 * app's own language: a warm hover wash, and — for the active route — a
 * lit amber edge instead of a filled pill, like a beam picking one item
 * out of the rail. */
.beacon-rail :deep(.v-list-item__overlay) {
  opacity: 0 !important;
}

.beacon-rail :deep(.v-list-item) {
  position: relative;
  margin-block: 2px;
}

.beacon-rail :deep(.v-list-item:hover) {
  background: var(--beacon-hover);
}

.beacon-rail :deep(.v-list-item--active) {
  background: var(--beacon-hover);
}

.beacon-rail :deep(.v-list-item--active)::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 0 10px 1px rgba(245, 169, 78, 0.55);
}

.beacon-rail :deep(.v-list-item--active .v-icon) {
  color: rgb(var(--v-theme-primary));
  filter: drop-shadow(0 0 5px rgba(245, 169, 78, 0.4));
}
</style>
