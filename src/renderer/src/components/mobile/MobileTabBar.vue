<template>
  <v-bottom-navigation app grow density="comfortable" color="primary" class="mobile-tabbar">
    <v-btn
      v-for="item in items"
      :key="item.to"
      :value="item.to"
      :active="isActive(item.to)"
      @click="$router.push(item.to)"
    >
      <v-icon :icon="item.icon" />
      <span class="mobile-tabbar__label">{{ item.label }}</span>
    </v-btn>
  </v-bottom-navigation>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'

export default {
  name: 'MobileTabBar',
  computed: {
    authStore() {
      return useAuthStore()
    },
    items() {
      return [
        {
          to: '/m/now-playing',
          icon: 'mdi-play-circle-outline',
          label: this.$t('mobile.tabNowPlaying'),
        },
        { to: '/m/queue', icon: 'mdi-playlist-music', label: this.$t('mobile.tabQueue') },
        { to: '/m/playlists', icon: 'mdi-playlist-play', label: this.$t('nav.playlists') },
        { to: '/m/library', icon: 'mdi-music-note', label: this.$t('nav.library') },
        this.authStore.capabilities.internetRadio
          ? { to: '/m/radio', icon: 'mdi-radio', label: this.$t('nav.radio') }
          : null,
      ].filter((item): item is { to: string; icon: string; label: string } => item !== null)
    },
  },
  methods: {
    // Only the exact tab routes themselves light up — a sub-page like
    // /m/playlists/:id intentionally leaves every tab unlit rather than
    // guessing which parent tab it "belongs" to.
    isActive(to: string): boolean {
      return this.$route.path === to
    },
  },
}
</script>

<style scoped>
.mobile-tabbar {
  border-top: 1px solid var(--beacon-hairline);
}

/* Vuetify gives each button a min-width of 80px and `grow` only ever
 * stretches them, never shrinks. Five tabs are 400px, which is wider than
 * every common phone: the row centred itself and hung 5px off each end at
 * 390px, more on a narrower screen, so the last tab (Radio) was the one
 * with a slice missing and a shrunken touch target. Sharing the bar
 * equally instead is what `grow` reads as anyway. */
.mobile-tabbar :deep(.v-btn) {
  min-width: 0;
  flex: 1 1 0;
  /* Vuetify's own 16px of side padding is a third of a tab at 320px, and it
   * is padding around a centred icon and label that need none — the label
   * gets that width instead. */
  padding-inline: 2px;
}

/* The ellipsis below only works once the label has a width to be capped
 * against: `max-width: 100%` resolves against Vuetify's .v-btn__content,
 * which has none of its own and grows with the text instead. A label longer
 * than its fifth of the bar (German's "Warteschlange", French's "File
 * d'attente") therefore overflowed the button and was clipped mid-word at
 * both ends. */
.mobile-tabbar :deep(.v-btn__content) {
  min-width: 0;
  max-width: 100%;
}

.mobile-tabbar__label {
  font-size: 0.65rem;
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
