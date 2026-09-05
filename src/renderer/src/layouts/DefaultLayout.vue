<template>
  <v-app>
    <!-- Switched, not hovered. expand-on-hover moved the whole layout
     - whenever the pointer crossed the left edge on its way somewhere
     - else, and gave no way to just keep the labels up; the state is a
     - deliberate choice now, remembered per device (see
     - services/sidebarSetting.ts).
     -
     - `width` is set rather than left at Vuetify's 256px default: the
     - longest label in any of the five locales is twelve characters
     - ("Statistiques", "Impostazioni", "Estadísticas"), which with the
     - icon and the list's own padding needs a little over 140px. 200
     - leaves room for a longer one without the rail taking a chunk of the
     - window it has no use for. -->
    <v-navigation-drawer
      v-model="drawerOpen"
      :rail="sidebarCollapsed"
      :width="SIDEBAR_WIDTH"
      permanent
      color="#0B0D13"
      class="beacon-rail"
    >
      <!-- Chrome, not a destination — its own list above the divider, so it
       - doesn't read as one more place to navigate to. -->
      <v-list density="compact" nav>
        <!-- Icon only, no label beside it: a hamburger that just opened the
         - rail is self-evidently the way to close it again, and spelling
         - that out is the one row of text nobody needs to read twice. The
         - wording lives on aria-label instead, for a reader that cannot see
         - which way the icon points. -->
        <v-list-item
          :prepend-icon="sidebarCollapsed ? 'mdi-menu' : 'mdi-menu-open'"
          :aria-label="$t(sidebarCollapsed ? 'nav.expandSidebar' : 'nav.collapseSidebar')"
          class="beacon-rail__toggle"
          @click="toggleSidebar"
        />
      </v-list>
      <v-divider class="beacon-rail__divider" />

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
      <v-icon
        icon="mdi-lighthouse-on"
        color="primary"
        size="20"
        class="beacon-glow app-bar__mark"
      />
      <v-app-bar-title class="app-title">Beacon</v-app-bar-title>
      <!-- Beside the app's own name rather than out with the search: this
       - is where every browser and every player that has one puts it, and
       - it is the first place someone looks when a detail page has
       - swallowed them. -->
      <nav-history-controls />
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
     - behavior as before either way.
     - model-value is forced false for this same first mount, on top of
     - that: queueDrawerOpen is already true in the store by the moment
     - queueDrawerEverOpened flips (that's what triggered it), so without
     - this override the component would be *born* already open, with no
     - closed frame ever committed to the page for the browser to animate
     - its very first opening transition from — the rows inside it
     - (QueueDrawer.vue's own reveal, timed against that transition)
     - visibly overshot and snapped back once real layout caught up.
     - queueDrawerFirstMountSettled releases it a tick later, once the
     - browser has had a real closed frame to start from — every open/close
     - after that first one passes queueDrawerOpen straight through, same
     - as before. Reported live 2026-08-26. -->
    <queue-drawer
      v-if="queueDrawerEverOpened"
      :model-value="queueDrawerFirstMountSettled && drawersStore.queueDrawerOpen"
      @update:model-value="drawersStore.setQueueDrawerOpen($event)"
    />
    <lyrics-drawer
      v-if="lyricsDrawerEverOpened"
      :model-value="onNowPlaying ? false : drawersStore.lyricsDrawerOpen"
      @update:model-value="drawersStore.lyricsDrawerOpen = $event"
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
import NavHistoryControls from '@/components/NavHistoryControls.vue'
import { usePlaybackStore } from '@/stores/playback'
import { useDrawersStore } from '@/stores/drawers'
import { useAuthStore } from '@/stores/auth'
import { loadSidebarCollapsed, saveSidebarCollapsed } from '@/services/sidebarSetting'

// How wide the rail is with its labels showing — see the drawer's own
// comment in the template for where the number comes from.
const SIDEBAR_WIDTH = 200

export default {
  name: 'DefaultLayout',
  components: {
    PlayerBar,
    QueueDrawer,
    LyricsDrawer,
    CastTakeoverConfirmDialog,
    TopBarSearch,
    NavHistoryControls,
  },
  data() {
    return {
      drawerOpen: true,
      sidebarCollapsed: loadSidebarCollapsed(),
      // Flips true the first time each drawer opens and never resets —
      // see the queue-drawer/lyrics-drawer v-if above for why.
      queueDrawerEverOpened: false,
      lyricsDrawerEverOpened: false,
      // See the queue-drawer's own model-value comment above — released
      // one tick after queueDrawerEverOpened first flips true.
      queueDrawerFirstMountSettled: false,
    }
  },
  computed: {
    SIDEBAR_WIDTH: () => SIDEBAR_WIDTH,
    playbackStore() {
      return usePlaybackStore()
    },
    drawersStore() {
      return useDrawersStore()
    },
    authStore() {
      return useAuthStore()
    },
    // NowPlayingView.vue renders lyrics inline (its own split-panel
    // transition) whenever drawersStore.lyricsDrawerOpen is true, driven
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
        { to: '/songs', icon: 'mdi-music-note', title: this.$t('nav.songs') },
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
    'drawersStore.queueDrawerOpen'(open: boolean) {
      if (open) this.queueDrawerEverOpened = true
    },
    'drawersStore.lyricsDrawerOpen'(open: boolean) {
      if (open) this.lyricsDrawerEverOpened = true
    },
    // Fires exactly once, right after the mount this same tick's v-if
    // triggers — see the queue-drawer's own model-value comment above for
    // why this can't just be true from the start.
    queueDrawerEverOpened(everOpened: boolean) {
      if (everOpened) this.$nextTick(() => (this.queueDrawerFirstMountSettled = true))
    },
  },
  methods: {
    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed
      saveSidebarCollapsed(this.sidebarCollapsed)
    },
  },
}
</script>

<style scoped>
/* Sized to the word, not stretched: the title's default `flex: 1 1 auto`
 * would push the history arrows all the way over to the search field,
 * away from the name they belong beside. */
.app-title {
  flex: 0 1 auto;
}

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

/* The toggle is chrome rather than a destination: no active state to ever
 * light up, and a quieter icon than the routes below it. */
.beacon-rail__toggle :deep(.v-icon) {
  color: rgba(255, 255, 255, 0.55);
}

.beacon-rail__divider {
  margin: 0 8px 4px;
  border-color: var(--beacon-hairline);
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

/* The lighthouse beside the app's name in the top bar. */
.app-bar__mark {
  margin-left: 16px;
  margin-right: 8px;
}
</style>
