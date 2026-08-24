<template>
  <div class="mobile-transport">
    <div class="d-flex align-center justify-center mb-1 mobile-transport__row">
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
        class="mobile-transport__play-btn mx-2"
        :icon="playbackStore.isPlaying ? 'mdi-pause' : 'mdi-play'"
        variant="flat"
        color="primary"
        size="large"
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

    <div class="d-flex align-center mb-2" style="gap: 10px">
      <span class="text-caption text-medium-emphasis mobile-transport__time">{{
        formatTime(seekPreviewPosition ?? playbackStore.localPosition)
      }}</span>
      <song-waveform
        :model-value="seekPreviewPosition ?? playbackStore.localPosition"
        :duration="playbackStore.duration"
        :disabled="!hasPlayable || !!playbackStore.radioStation"
        @update:model-value="seekPreviewPosition = $event"
        @end="onSeekEnd"
      />
      <span class="text-caption text-medium-emphasis mobile-transport__time text-right">{{
        formatTime(playbackStore.duration)
      }}</span>
    </div>

    <div class="d-flex align-center" style="gap: 10px">
      <v-btn
        :icon="connectStore.isActive ? 'mdi-cast-connected' : 'mdi-cast'"
        :color="connectStore.isActive ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        @click="devicePickerOpen = true"
      />
      <v-btn
        :icon="volumeIcon"
        :disabled="muteDisabled"
        variant="text"
        density="comfortable"
        size="small"
        @click="toggleMute"
      />
      <v-slider
        v-if="singleActiveTarget"
        :model-value="deviceVolume ?? 0"
        :max="100"
        :step="1"
        :disabled="deviceVolume == null"
        density="compact"
        hide-details
        @update:model-value="onDeviceVolumeChange"
      />
      <v-slider
        v-else
        :model-value="playbackStore.volume"
        :max="1"
        density="compact"
        hide-details
        :disabled="playbackStore.isCasting"
        @update:model-value="playbackStore.setVolume($event)"
      />
      <span class="text-caption text-medium-emphasis mobile-transport__volume-value">{{
        volumePercentLabel
      }}</span>
    </div>

    <mobile-device-picker v-model="devicePickerOpen" />
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useConnectStore } from '@/stores/connect'
import SongWaveform from '@/components/player/SongWaveform.vue'
import MobileDevicePicker from './MobileDevicePicker.vue'
import type { ConnectDeviceRef } from '@/services/connect/types'

export default {
  name: 'MobileTransportControls',
  components: { SongWaveform, MobileDevicePicker },
  data() {
    return {
      devicePickerOpen: false,
      deviceVolume: null as number | null,
      volumePollTimer: null as ReturnType<typeof setInterval> | null,
      // Same purpose as PlayerBar.vue's identical field — decoupled visual
      // drag position vs. the actual seek() round-trip, fired once on
      // release rather than on every drag tick.
      seekPreviewPosition: null as number | null,
      // What to restore to on un-mute — same pair PlayerBar.vue songs, see
      // its own comment.
      volumeBeforeMute: 1,
      deviceVolumeBeforeMute: 50,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    connectStore() {
      return useConnectStore()
    },
    hasPlayable() {
      return this.playbackStore.currentSong != null || this.playbackStore.radioStation != null
    },
    repeatIcon() {
      return this.playbackStore.repeatMode === 'one' ? 'mdi-repeat-once' : 'mdi-repeat'
    },
    singleActiveTarget() {
      const targets = this.connectStore.activeTargets
      return targets.length === 1 ? targets[0] : null
    },
    singleActiveTargetKey() {
      const target = this.singleActiveTarget
      return target ? `${target.type}:${target.name}` : null
    },
    volumePercentLabel() {
      if (this.singleActiveTarget) {
        return this.deviceVolume == null ? '—' : `${this.deviceVolume}%`
      }
      return `${Math.round(this.playbackStore.volume * 100)}%`
    },
    volumeIcon() {
      const muted = this.singleActiveTarget
        ? this.deviceVolume === 0
        : this.playbackStore.volume === 0
      return muted ? 'mdi-volume-mute' : 'mdi-volume-high'
    },
    muteDisabled() {
      return this.singleActiveTarget ? this.deviceVolume == null : this.playbackStore.isCasting
    },
    // Pushed reading for push-capable types (Sonos today - see
    // connectStore.isVolumePushCapable()'s own comment), null for
    // everything else (and whenever nothing's pushed a reading yet), which
    // the watcher below simply ignores rather than overwriting a real value
    // with nothing.
    pushedDeviceVolume(): number | null {
      const target = this.singleActiveTarget
      return target ? this.connectStore.pushedVolumeFor(target.type, target.name) : null
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
          // Still needed for every type, push-capable included: a push
          // channel only ever fires on the *next* change, so the very
          // first paint still needs one real round trip.
          this.fetchDeviceVolume(this.singleActiveTarget)
          if (!this.connectStore.isVolumePushCapable(this.singleActiveTarget.type)) {
            this.volumePollTimer = setInterval(() => {
              if (this.singleActiveTarget) this.fetchDeviceVolume(this.singleActiveTarget)
            }, 4000)
          }
        }
      },
    },
    pushedDeviceVolume(value: number | null) {
      if (value != null) this.deviceVolume = value
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
      await this.playbackStore.seek(value)
      this.seekPreviewPosition = null
    },
    toggleMute() {
      if (this.singleActiveTarget) {
        if (this.deviceVolume === 0) {
          void this.onDeviceVolumeChange(this.deviceVolumeBeforeMute || 50)
        } else {
          this.deviceVolumeBeforeMute = this.deviceVolume ?? 50
          void this.onDeviceVolumeChange(0)
        }
        return
      }
      if (this.playbackStore.volume === 0) {
        this.playbackStore.setVolume(this.volumeBeforeMute || 1)
      } else {
        this.volumeBeforeMute = this.playbackStore.volume
        this.playbackStore.setVolume(0)
      }
    },
  },
}
</script>

<style scoped>
.mobile-transport {
  padding: 0 16px calc(6px + env(safe-area-inset-bottom));
}

.mobile-transport__row {
  gap: 4px;
}

.mobile-transport__play-btn :deep(.v-icon) {
  color: rgb(var(--v-theme-background));
}

.mobile-transport__time {
  width: 36px;
  flex-shrink: 0;
}

.text-right {
  text-align: right;
}

.mobile-transport__volume-value {
  width: 32px;
  text-align: right;
  flex-shrink: 0;
}
</style>
