<template>
  <div class="now-playing fill-height d-flex align-center justify-center" :style="ambientStyle">
    <div v-if="hasPlayable" class="now-playing__content">
      <div class="now-playing__art-wrap">
        <div class="now-playing__art-glow" :style="{ background: glowColor }" />
        <cover-art
          v-if="currentTrack"
          :cover-art-id="currentTrack.coverArtId"
          :size="540"
          class="cover-shadow"
        />
        <v-icon v-else icon="mdi-radio" size="260" class="now-playing__radio-icon" />
      </div>

      <div class="now-playing__info">
        <div class="eyebrow-label mb-2">{{ eyebrow }}</div>
        <h1 class="detail-title now-playing__title mb-2">
          {{ currentTrack?.title ?? playbackStore.radioStation?.name }}
        </h1>
        <div class="text-h6 text-medium-emphasis mb-2">{{ currentTrack?.artist ?? '' }}</div>
        <router-link
          v-if="currentTrack"
          :to="`/albums/${currentTrack.albumId}`"
          class="text-body-2 text-medium-emphasis now-playing__album-link"
        >
          {{ currentTrack.album }}
        </router-link>
      </div>
    </div>

    <div v-else class="now-playing__content">
      <span class="text-medium-emphasis">{{ $t('nowPlaying.nothingPlaying') }}</span>
    </div>
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import CoverArt from '@/components/library/CoverArt.vue'
import { extractDominantColor } from '@/services/colorExtractor'

// Warm amber — the same signal color the app is named after (see main.ts's
// 'beacon' theme) — used whenever there's nothing to extract a color from
// yet (radio has no artwork, or extraction is still in flight/failed).
const FALLBACK_COLOR = '245, 169, 78'

export default {
  name: 'NowPlayingView',
  components: { CoverArt },
  data() {
    return {
      // "r, g, b" — kept as a CSS-ready string so the two computed styles
      // below don't each redo the same join().
      extractedColor: null as string | null,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    currentTrack() {
      return this.playbackStore.currentTrack
    },
    hasPlayable() {
      return this.currentTrack != null || this.playbackStore.radioStation != null
    },
    eyebrow() {
      if (this.currentTrack)
        return this.playbackStore.isPlaying ? this.$t('home.nowPlaying') : this.$t('home.paused')
      if (this.playbackStore.radioStation) return this.$t('home.radioEyebrow')
      return ''
    },
    coverArtUrl(): string | null {
      const id = this.currentTrack?.coverArtId
      return id ? useLibraryStore().client().coverArtUrl(id, 400) : null
    },
    colorTriplet(): string {
      return this.extractedColor ?? FALLBACK_COLOR
    },
    // A soft, wide wash filling the whole screen — the "room" the artwork
    // sits in reacts to whatever's playing, the same idea as the lighthouse
    // in the app's own name: the light changes color with what it's
    // guiding you through.
    ambientStyle() {
      return {
        background: `radial-gradient(ellipse 65% 55% at 50% 32%, rgba(${this.colorTriplet}, 0.35), rgba(18, 20, 28, 0) 70%), #12141C`,
      }
    },
    // A tighter, brighter halo immediately behind the artwork — a light
    // source rather than a room tint, layered on top of ambientStyle.
    glowColor() {
      return `radial-gradient(circle, rgba(${this.colorTriplet}, 0.55) 0%, rgba(${this.colorTriplet}, 0) 70%)`
    },
  },
  watch: {
    coverArtUrl: {
      immediate: true,
      handler(url: string | null) {
        this.extractedColor = null
        if (url) this.loadColor(url)
      },
    },
  },
  methods: {
    async loadColor(url: string) {
      const color = await extractDominantColor(url)
      // The track may have changed again while the image was loading —
      // don't let a stale extraction overwrite whatever's current now.
      if (url !== this.coverArtUrl) return
      this.extractedColor = color ? color.join(', ') : null
    },
  },
}
</script>

<style scoped>
.now-playing {
  width: 100%;
  /* Ambient color is set inline (:style) since it depends on the track;
   * the transition is what makes it change *into* the new color smoothly
   * on a track change instead of snapping. */
  transition: background 1.2s ease;
}

.now-playing__content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 32px;
  max-width: 640px;
}

.now-playing__art-wrap {
  position: relative;
  margin-bottom: 40px;
}

.now-playing__art-glow {
  position: absolute;
  inset: -70px;
  border-radius: 50%;
  filter: blur(60px);
  transition: background 1.2s ease;
  z-index: 0;
}

.now-playing__art-wrap :deep(.cover-art),
.now-playing__radio-icon {
  position: relative;
  z-index: 1;
}

.now-playing__title {
  font-size: 2.5rem;
  line-height: 1.15;
}

.now-playing__album-link {
  text-decoration: none;
}

.now-playing__album-link:hover {
  color: rgb(var(--v-theme-primary));
}
</style>
