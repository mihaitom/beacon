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
    <!-- The same artwork size the list rows above this bar use
     - (MOBILE_ROW_ART_SIZE) — this strip sits directly under one of those
     - lists, and the phone remote's own mini player already matches its
     - rows the same way. -->
    <cover-art
      v-if="currentSong"
      :cover-art-id="currentSong.coverArtId"
      :size="MOBILE_ROW_ART_SIZE"
      class="mobile-player-bar__art"
    />
    <cover-art
      v-else-if="playbackStore.radioStation"
      :radio-favicon="radioFavicon"
      :size="MOBILE_ROW_ART_SIZE"
      fallback-icon="mdi-radio"
      class="mobile-player-bar__art"
    />
    <!-- Same two labels SongInfo.vue's desktop player bar shows, in the
     - same order and with the same fallback chain — the station's ICY "now
     - playing" tag on top (what is actually playing right now) and the
     - station name below it, station name alone until a tag arrives. This
     - bar used to show only the station name, which meant the tag the
     - backend was already watching for (services/connect/radioMetadata.ts)
     - never appeared anywhere on a phone except Now Playing. -->
    <div class="mobile-player-bar__labels">
      <div class="text-body-medium text-truncate">
        {{
          currentSong?.title ?? playbackStore.radioNowPlaying ?? playbackStore.radioStation?.name
        }}
      </div>
      <div class="text-body-small text-medium-emphasis text-truncate">
        {{ currentSong?.artist ?? (playbackStore.radioNowPlaying ? radioStationName : '') }}
      </div>
    </div>
    <!-- Previous/next flank play the same way every transport row does.
     - Not gated on hasPrevious: at the start of a queue "previous" restarts
     - the current song rather than doing nothing, which is what
     - MobileTransportControls.vue's own button relies on too. -->
    <v-btn
      icon="mdi-skip-previous"
      variant="text"
      :disabled="isRadio"
      @click.stop="playbackStore.playPrevious()"
    />
    <v-btn
      :icon="playbackStore.isPlaying ? 'mdi-pause' : 'mdi-play'"
      variant="text"
      size="large"
      @click.stop="playbackStore.togglePlay()"
    />
    <!-- Radio has no queue to skip through — see MobileTransportControls.vue's
     - own gating comment. -->
    <v-btn
      icon="mdi-skip-next"
      variant="text"
      :disabled="isRadio || !playbackStore.hasNext"
      @click.stop="playbackStore.playNext()"
    />
  </v-footer>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { MOBILE_ROW_ART_SIZE } from './rowMetrics'
import { radioFaviconRequest, type RadioFaviconRequest } from '@/services/connect/radio'
import CoverArt from '@/components/library/CoverArt.vue'

export default {
  name: 'MobilePlayerBar',
  components: { CoverArt },
  data() {
    return { MOBILE_ROW_ART_SIZE }
  },
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
    isRadio() {
      return this.playbackStore.radioStation != null
    },
    radioStationName(): string {
      return this.playbackStore.radioStation?.name ?? ''
    },
    radioFavicon(): RadioFaviconRequest | null {
      const station = this.playbackStore.radioStation
      if (!station?.homePageUrl && !station?.favicon) return null
      return radioFaviconRequest(station.homePageUrl ?? '', 96, station.favicon ?? '')
    },
  },
}
</script>

<style scoped>
.mobile-player-bar {
  border-top: 1px solid var(--beacon-hairline);
  cursor: pointer;
}

.mobile-player-bar__art {
  flex-shrink: 0;
  margin-right: 12px;
}

/* min-width: 0 is what lets the two labels truncate — a flex item defaults
 * to its content's own width, which defeats text-overflow. */
.mobile-player-bar__labels {
  flex: 1;
  min-width: 0;
}
</style>
