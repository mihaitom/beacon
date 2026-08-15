<template>
  <v-footer app inset height="88" color="#0B0D13" class="player-bar px-4">
    <div class="d-flex align-center w-100" style="gap: 16px">
      <div
        class="track-info d-flex align-center"
        style="width: 220px; cursor: pointer"
        @click="hasPlayable && $router.push('/now-playing')"
      >
        <cover-art
          v-if="currentTrack"
          :cover-art-id="currentTrack.coverArtId"
          :size="48"
          class="player-bar__cover mr-3"
        />
        <cover-art
          v-else-if="playbackStore.radioStation"
          :image-url="radioFaviconSrc"
          :size="48"
          fallback-icon="mdi-radio"
          class="player-bar__cover mr-3"
        />
        <div class="min-width-0">
          <div class="text-body-2 text-truncate">
            {{
              currentTrack?.title ?? playbackStore.radioStation?.name ?? $t('player.nothingPlaying')
            }}
          </div>
          <router-link
            v-if="currentTrack"
            :to="`/artists/${currentTrack.artistId}`"
            class="text-caption text-medium-emphasis text-truncate player-bar__artist-link"
            @click.stop
          >
            {{ currentTrack.artist }}
          </router-link>
          <div v-else class="text-caption text-medium-emphasis text-truncate" />
        </div>
        <v-btn
          v-if="currentTrack"
          :icon="currentTrack.starred ? 'mdi-heart' : 'mdi-heart-outline'"
          :color="currentTrack.starred ? 'primary' : undefined"
          :disabled="starringInFlight"
          variant="text"
          density="comfortable"
          size="small"
          @click.stop="toggleStar"
        />
      </div>

      <div class="flex-grow-1 d-flex flex-column align-center min-width-0">
        <div class="d-flex align-center" style="gap: 4px">
          <v-btn
            icon="mdi-shuffle"
            :color="playbackStore.shuffle ? 'primary' : undefined"
            variant="text"
            density="comfortable"
            @click="playbackStore.toggleShuffle()"
          />
          <v-btn
            icon="mdi-skip-previous"
            variant="text"
            density="comfortable"
            :disabled="!hasPlayable"
            @click="playbackStore.playPrevious()"
          />
          <v-btn
            class="player-bar__play-btn mx-1"
            :icon="playbackStore.isPlaying ? 'mdi-pause' : 'mdi-play'"
            variant="flat"
            color="primary"
            size="large"
            density="comfortable"
            :disabled="!hasPlayable"
            @click="playbackStore.togglePlay()"
          />
          <v-btn
            icon="mdi-skip-next"
            variant="text"
            density="comfortable"
            :disabled="!hasPlayable || !playbackStore.hasNext"
            @click="playbackStore.playNext()"
          />
          <v-btn
            :icon="repeatIcon"
            :color="playbackStore.repeatMode !== 'off' ? 'primary' : undefined"
            variant="text"
            density="comfortable"
            @click="playbackStore.cycleRepeatMode()"
          />
        </div>
        <div class="d-flex align-center w-100" style="gap: 8px; max-width: 600px">
          <span class="text-caption text-medium-emphasis" style="width: 40px">{{
            formatTime(seekPreviewPosition ?? playbackStore.localPosition)
          }}</span>
          <track-waveform
            :model-value="seekPreviewPosition ?? playbackStore.localPosition"
            :duration="playbackStore.duration"
            :disabled="!hasPlayable || !!playbackStore.radioStation"
            @update:model-value="seekPreviewPosition = $event"
            @end="onSeekEnd"
          />
          <span class="text-caption text-medium-emphasis" style="width: 40px">{{
            formatTime(playbackStore.duration)
          }}</span>
        </div>
      </div>

      <div class="d-flex align-center" style="min-width: 320px; gap: 4px">
        <v-btn
          v-if="currentTrack"
          icon="mdi-script-text-outline"
          variant="text"
          density="comfortable"
          :title="$t('lyrics.title')"
          @click="playbackStore.toggleLyricsDrawer()"
        />
        <v-btn
          icon="mdi-playlist-music"
          variant="text"
          density="comfortable"
          @click="playbackStore.toggleQueueDrawer()"
        />
        <connect-button />
        <v-icon icon="mdi-volume-high" size="small" class="mr-1" />
        <v-slider
          v-if="singleActiveTarget"
          :model-value="deviceVolume ?? 0"
          :max="100"
          :step="1"
          :disabled="deviceVolume == null"
          density="compact"
          hide-details
          style="max-width: 200px"
          @update:model-value="onDeviceVolumeChange"
        />
        <v-slider
          v-else
          :model-value="playbackStore.volume"
          :max="1"
          density="compact"
          hide-details
          :disabled="playbackStore.isCasting"
          style="max-width: 200px"
          @update:model-value="playbackStore.setVolume($event)"
        />
        <span class="text-caption text-medium-emphasis volume-value">{{ volumePercentLabel }}</span>
      </div>
    </div>
  </v-footer>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import { useConnectStore } from '@/stores/connect'
import { useAuthStore } from '@/stores/auth'
import { radioFaviconUrl } from '@/services/connect/radio'
import CoverArt from '@/components/library/CoverArt.vue'
import ConnectButton from '@/components/connect/ConnectButton.vue'
import TrackWaveform from './TrackWaveform.vue'
import type { ConnectDeviceRef } from '@/services/connect/types'

export default {
  name: 'PlayerBar',
  components: { CoverArt, ConnectButton, TrackWaveform },
  data() {
    return {
      // null while unfetched/unsupported (e.g. DLNA renderer without volume
      // control) — see connectStore.getDeviceVolume().
      deviceVolume: null as number | null,
      starringInFlight: false,
      // Connect's SSE status has no volume field, so there's no push
      // channel for "someone changed it on the device itself/another
      // session" — polling is the only way this slider ever finds out.
      volumePollTimer: null as ReturnType<typeof setInterval> | null,
      // Non-null only while actively dragging the seek bar (TrackWaveform)
      // — decouples its live visual position from playbackStore.seek()
      // itself, which used to fire on every drag tick via
      // @update:model-value. During casting each of those was a real
      // round-trip to the device (Sonos/Chromecast/etc.) — dozens of
      // overlapping seek commands during one drag made the device
      // audibly struggle to keep up and settle. Now @update:model-value
      // only updates this (purely visual), and the actual seek() call
      // fires once, from @end, when the drag finishes.
      seekPreviewPosition: null as number | null,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    connectStore() {
      return useConnectStore()
    },
    currentTrack() {
      return this.playbackStore.currentTrack
    },
    // 96, not 48 (the box's actual CSS size) — a favicon this small still
    // benefits from headroom on a high-DPI display, and the source is
    // free to just be smaller than that if that's all the station's
    // homepage actually declares (see routes/radio.py's _select()).
    radioFaviconSrc(): string | null {
      const homePageUrl = this.playbackStore.radioStation?.homePageUrl
      if (!homePageUrl) return null
      const auth = useAuthStore()
      return radioFaviconUrl(auth.apiUrl, auth.connectToken, homePageUrl, 96)
    },
    hasPlayable() {
      return this.currentTrack != null || this.playbackStore.radioStation != null
    },
    repeatIcon() {
      return this.playbackStore.repeatMode === 'one' ? 'mdi-repeat-once' : 'mdi-repeat'
    },
    // Only meaningful to control from here when there's exactly one active
    // cast target — with several, "the" volume is ambiguous (that's what
    // the per-device sliders in the connect picker are for).
    singleActiveTarget() {
      const targets = this.connectStore.activeTargets
      return targets.length === 1 ? targets[0] : null
    },
    // Watched instead of singleActiveTarget itself — that's a fresh object
    // parsed from every SSE status tick (~2s), so a reference-equality
    // watch on it fires every tick even when it's the exact same device,
    // resetting deviceVolume to null (slider flashes to 0) and re-fetching
    // for no reason. A string key is stable across ticks as long as the
    // device itself hasn't changed.
    singleActiveTargetKey() {
      const target = this.singleActiveTarget
      return target ? `${target.type}:${target.name}` : null
    },
    volumePercentLabel() {
      if (this.singleActiveTarget) {
        return this.deviceVolume == null ? '—' : `${this.deviceVolume}`
      }
      return `${Math.round(this.playbackStore.volume * 100)}%`
    },
  },
  watch: {
    singleActiveTargetKey: {
      immediate: true,
      handler() {
        this.deviceVolume = null
        clearInterval(this.volumePollTimer ?? undefined)
        this.volumePollTimer = null
        if (this.singleActiveTarget) {
          this.fetchDeviceVolume(this.singleActiveTarget)
          this.volumePollTimer = setInterval(() => {
            if (this.singleActiveTarget) this.fetchDeviceVolume(this.singleActiveTarget)
          }, 4000)
        }
      },
    },
  },
  beforeUnmount() {
    clearInterval(this.volumePollTimer ?? undefined)
  },
  methods: {
    formatTime(seconds: number): string {
      const total = Math.max(0, Math.round(seconds))
      const minutes = Math.floor(total / 60)
      const secs = total % 60
      return `${minutes}:${String(secs).padStart(2, '0')}`
    },
    async fetchDeviceVolume(target: ConnectDeviceRef) {
      const raw = await this.connectStore.getDeviceVolume(target.type, target.name)
      this.deviceVolume = raw == null ? null : Math.round(raw)
    },
    async onDeviceVolumeChange(value: number) {
      const target = this.singleActiveTarget
      if (!target) return
      const rounded = Math.round(value)
      this.deviceVolume = rounded
      await this.connectStore.setDeviceVolume(target.type, target.name, rounded)
    },
    async onSeekEnd(value: number) {
      // Cleared only *after* seek() resolves (it sets localPosition to
      // this same value once done) — clearing first would flash the
      // slider back to the pre-seek position for whatever the round-trip
      // takes.
      await this.playbackStore.seek(value)
      this.seekPreviewPosition = null
    },
    async toggleStar() {
      if (!this.currentTrack || this.starringInFlight) return
      this.starringInFlight = true
      const track = this.currentTrack
      const wasStarred = track.starred
      try {
        await useLibraryStore().toggleStar({ id: track.id, starred: wasStarred })
        // Flip the captured track, not this.currentTrack — the track that
        // was actually playing might have advanced during the round-trip.
        track.starred = !wasStarred
      } finally {
        this.starringInFlight = false
      }
    },
  },
}
</script>

<style scoped>
.player-bar {
  border-top: 1px solid var(--beacon-hairline);
}

.player-bar__cover {
  flex-shrink: 0;
}

/* Block, not the anchor's default inline — text-truncate (overflow/
 * white-space/ellipsis) needs a constrained box to truncate against,
 * which an inline element sitting in normal block flow doesn't have here
 * (this row isn't itself a flex item, see .min-width-0 above it). */
.player-bar__artist-link {
  display: block;
  text-decoration: none;
}

.player-bar__artist-link:hover {
  color: rgb(var(--v-theme-primary));
}

/* The center column (transport + seek slider) is the only flex-grow item
 * in the row and has no min-width of its own — without min-width:0 it
 * refuses to shrink below its content's natural width, so at real window
 * widths it pushed the seek slider past the window edge instead of
 * shrinking. This is the one-line fix; nothing else about the layout
 * changed. */
.min-width-0 {
  min-width: 0;
}

/* Filled, inverted-color circle — reads as "the" button at a glance next
 * to the flanking transport buttons' plain outlined icons. */
.player-bar__play-btn :deep(.v-icon) {
  color: rgb(var(--v-theme-background));
}

.volume-value {
  width: 32px;
  text-align: right;
}
</style>
