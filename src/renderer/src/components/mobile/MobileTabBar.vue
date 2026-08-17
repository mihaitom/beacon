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
        { to: '/m/now-playing', icon: 'mdi-play-circle-outline', label: this.$t('mobile.tabNowPlaying') },
        { to: '/m/queue', icon: 'mdi-playlist-music', label: this.$t('mobile.tabQueue') },
        { to: '/m/playlists', icon: 'mdi-playlist-play', label: this.$t('nav.playlists') },
        { to: '/m/tracks', icon: 'mdi-music-note', label: this.$t('nav.tracks') },
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

.mobile-tabbar__label {
  font-size: 0.65rem;
}
</style>
