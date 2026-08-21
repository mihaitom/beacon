<template>
  <div class="toolbar d-flex align-center">
    <v-btn
      v-if="currentSong"
      icon="mdi-script-text-outline"
      :color="playbackStore.lyricsDrawerOpen ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      :title="$t('lyrics.title')"
      @click="playbackStore.toggleLyricsDrawer()"
    />
    <v-btn
      icon="mdi-playlist-music"
      :color="playbackStore.queueDrawerOpen ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      @click="playbackStore.toggleQueueDrawer()"
    />
    <v-btn
      v-if="authStore.capabilities.songRadio"
      icon="mdi-infinity"
      :color="autoplayStore.enabled ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      :title="$t('player.autoplay')"
      @click="autoplayStore.setEnabled(!autoplayStore.enabled)"
    />
    <!-- Electron-only (pairs a phone against *this* desktop window over
     - the LAN) — see App.vue's identical `window.api` gate on the whole
     - feature. No Docker/web equivalent: there's no separate desktop
     - instance to pair against there. -->
    <remote-control-button v-if="isElectron" />
    <connect-button />
    <template v-if="!volumeCollapsed">
      <v-btn
        :icon="volumeIcon"
        :disabled="muteDisabled"
        variant="text"
        density="comfortable"
        size="small"
        :title="$t('player.mute')"
        @click="toggleMute"
      />
      <v-slider
        v-if="singleActiveTarget"
        class="volume-slider"
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
        class="volume-slider"
        :model-value="playbackStore.volume"
        :max="1"
        density="compact"
        hide-details
        :disabled="playbackStore.isCasting"
        @update:model-value="playbackStore.setVolume($event)"
      />
      <span class="text-caption text-medium-emphasis volume-value">{{ volumePercentLabel }}</span>
    </template>
    <!-- While volumeCollapsed, the slider/label above don't render at all
     - — this activator (not itself the mute toggle, unlike the expanded
     - button above) is the only way to reach them, same click-to-open
     - pattern as connect-button/remote-control-button right next to it.
     - Not :disabled — muteDisabled only gates the actual mute toggle
     - inside the popover; the popover itself should still open to at
     - least show the (disabled) slider and why. -->
    <v-menu v-else :close-on-content-click="false" location="top">
      <template #activator="{ props: menuProps }">
        <v-btn
          :icon="volumeIcon"
          variant="text"
          density="comfortable"
          size="small"
          :title="$t('player.volume')"
          v-bind="menuProps"
        />
      </template>
      <v-card min-width="220" class="volume-popover">
        <v-card-text class="d-flex align-center" style="gap: 8px">
          <v-btn
            :icon="volumeIcon"
            :disabled="muteDisabled"
            variant="text"
            density="comfortable"
            size="small"
            :title="$t('player.mute')"
            @click="toggleMute"
          />
          <v-slider
            v-if="singleActiveTarget"
            class="volume-slider"
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
            class="volume-slider"
            :model-value="playbackStore.volume"
            :max="1"
            density="compact"
            hide-details
            :disabled="playbackStore.isCasting"
            @update:model-value="playbackStore.setVolume($event)"
          />
          <span class="text-caption text-medium-emphasis volume-value">{{
            volumePercentLabel
          }}</span>
        </v-card-text>
      </v-card>
    </v-menu>
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useConnectStore } from '@/stores/connect'
import { useAuthStore } from '@/stores/auth'
import { useAutoplayStore } from '@/stores/autoplay'
import ConnectButton from '@/components/connect/ConnectButton.vue'
import RemoteControlButton from '@/components/settings/RemoteControlButton.vue'
import type { ConnectDeviceRef } from '@/services/connect/types'

export default {
  name: 'PlayerToolbar',
  components: { ConnectButton, RemoteControlButton },
  props: {
    // Driven by PlayerBar.vue's own ResizeObserver, off the *whole bar's*
    // real rendered width, not something this element could determine by
    // watching only itself — a too-narrow bar can come from song-info or
    // control-container needing more room just as easily as this element
    // needing more of its own.
    volumeCollapsed: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      // null while unfetched/unsupported (e.g. DLNA renderer without volume
      // control) — see connectStore.getDeviceVolume().
      deviceVolume: null as number | null,
      // Connect's SSE status has no volume field, so there's no push
      // channel for "someone changed it on the device itself/another
      // session" — polling is the only way this slider ever finds out.
      volumePollTimer: null as ReturnType<typeof setInterval> | null,
      // What to restore to on un-mute — captured right before muting, same
      // pattern as DeviceListItem.vue's own onToggleMute(). Two separate
      // fields since local volume (0-1) and device volume (0-100) are on
      // different scales and muted independently of one another.
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
    authStore() {
      return useAuthStore()
    },
    autoplayStore() {
      return useAutoplayStore()
    },
    currentSong() {
      return this.playbackStore.currentSong
    },
    // Same check as SettingsView.vue's own `isElectron` gate on the Remote
    // Control section this button surfaces here instead.
    isElectron(): boolean {
      return !!window.api
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
    // Always a "%" now, whichever source it's reading from — this used to
    // show a bare number while casting to a single device (0-100 scale)
    // but "42%" during local playback (0-1 scale rounded), inconsistent for
    // no reason other than the two branches never having been reconciled.
    volumePercentLabel() {
      if (this.singleActiveTarget) {
        return this.deviceVolume == null ? '—' : `${this.deviceVolume}%`
      }
      return `${Math.round(this.playbackStore.volume * 100)}%`
    },
    // Mirrors DeviceListItem.vue's own two-state volumeIcon (mute vs. not) —
    // same simple mute/not-mute distinction, not a third "medium" state.
    volumeIcon() {
      const muted = this.singleActiveTarget
        ? this.deviceVolume === 0
        : this.playbackStore.volume === 0
      return muted ? 'mdi-volume-mute' : 'mdi-volume-high'
    },
    muteDisabled() {
      return this.singleActiveTarget ? this.deviceVolume == null : this.playbackStore.isCasting
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
/* justify-self: end — its own grid track (see PlayerBar.vue's
 * .player-bar__row) is only ever exactly as wide as this element's own
 * natural content in the *widest* real case; every narrower state (fewer
 * icons, no device-volume slider, ...) leaves this row some unused room
 * on the left of its own track. Right-aligning within it keeps every icon
 * flush against the bar's own right edge (px-4) regardless of exactly how
 * many are currently shown, instead of drifting depending on whatever's
 * rendered right now. */
.toolbar {
  gap: 4px;
  justify-self: end;
}

/* A real width, not max-width — this used to be allowed to shrink down to
 * almost nothing (as low as ~64px measured at a realistic window size)
 * once the row ran out of room, well before the seek bar gave up any of
 * its own space. */
.volume-slider {
  width: 150px;
}

.volume-value {
  width: 32px;
  text-align: right;
}

/* Same dark-chrome popover treatment as ConnectDevicePicker.vue's own
 * .connect-picker / RemoteControlButton.vue's own .remote-control-menu
 * (also v-menus floating off a PlayerBar icon) — Vue scoped styles don't
 * share across components just by reusing a class name, so this
 * redeclares it rather than actually reusing theirs. */
.volume-popover {
  border: 1px solid var(--beacon-hairline);
}
</style>
