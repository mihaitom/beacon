<template>
  <v-footer
    v-if="hasPlayable"
    app
    inset
    height="60"
    color="#0B0D13"
    class="mobile-player-bar px-3"
    @click="$router.push('/m/now-playing')"
  >
    <cover-art
      v-if="currentSong"
      :cover-art-id="currentSong.coverArtId"
      :size="40"
      class="mr-3 flex-shrink-0"
    />
    <cover-art
      v-else-if="playbackStore.radioStation"
      :image-url="radioFaviconSrc"
      :size="40"
      fallback-icon="mdi-radio"
      class="mr-3 flex-shrink-0"
    />
    <div class="min-width-0 flex-grow-1">
      <div class="text-body-medium text-truncate">
        {{ currentSong?.title ?? playbackStore.radioStation?.name }}
      </div>
      <div class="text-body-small text-medium-emphasis text-truncate">
        {{ currentSong?.artist ?? '' }}
      </div>
    </div>
    <v-btn
      :icon="playbackStore.isPlaying ? 'mdi-pause' : 'mdi-play'"
      variant="text"
      size="large"
      @click.stop="playbackStore.togglePlay()"
    />
    <v-btn
      icon="mdi-skip-next"
      variant="text"
      :disabled="!playbackStore.hasNext"
      @click.stop="playbackStore.playNext()"
    />
  </v-footer>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { radioFaviconUrl } from '@/services/connect/radio'
import CoverArt from '@/components/library/CoverArt.vue'

export default {
  name: 'MobilePlayerBar',
  components: { CoverArt },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    currentSong() {
      return this.playbackStore.currentSong
    },
    hasPlayable() {
      return this.currentSong != null || this.playbackStore.radioStation != null
    },
    radioFaviconSrc(): string | null {
      const homePageUrl = this.playbackStore.radioStation?.homePageUrl
      if (!homePageUrl) return null
      const auth = useAuthStore()
      return radioFaviconUrl(auth.apiUrl, auth.connectToken, homePageUrl, 96)
    },
  },
}
</script>

<style scoped>
.mobile-player-bar {
  border-top: 1px solid var(--beacon-hairline);
  cursor: pointer;
}

.min-width-0 {
  min-width: 0;
}
</style>
