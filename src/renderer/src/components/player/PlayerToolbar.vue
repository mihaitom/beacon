<template>
  <div class="toolbar">
    <!-- Radio included: the drawer holds that station's title log
       - instead of lyrics (see LyricsDrawer.vue), and gating this on
       - currentSong alone meant there was no way to open it at all. -->
    <v-btn
      v-if="currentSong || radioStation"
      :icon="radioStation && !currentSong ? 'mdi-history' : 'mdi-script-text-outline'"
      :color="drawersStore.lyricsDrawerOpen ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      :title="radioStation && !currentSong ? $t('radio.titleLog') : $t('lyrics.title')"
      @click="drawersStore.toggleLyricsDrawer()"
    />
    <v-btn
      icon="mdi-playlist-music"
      :color="drawersStore.queueDrawerOpen ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      @click="drawersStore.toggleQueueDrawer()"
    />
    <v-btn
      v-if="authStore.capabilities.songRadio"
      icon="mdi-infinity"
      :color="autoplayStore.enabled ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      :title="$t('player.autoplay')"
      @click="playbackStore.setAutoplayEnabled(!autoplayStore.enabled)"
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
        @start="onVolumeDragStart"
        @end="onVolumeDragEnd"
        @wheel="onVolumeWheel"
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
        @wheel="onVolumeWheel"
      />
      <span class="text-body-small text-medium-emphasis volume-value">{{
        volumePercentLabel
      }}</span>
    </template>
    <!-- While volumeCollapsed, the slider/label above don't render at all
     - — this activator (not itself the mute toggle, unlike the expanded
     - button above) is the only way to reach them, same click-to-open
     - pattern as connect-button/remote-control-button right next to it.
     - Not :disabled — muteDisabled only gates the actual mute toggle
     - inside the popover; the popover itself should still open to at
     - least show the (disabled) slider and why. -->
    <!-- Pinned to the bar's bottom-right corner rather than to this
     - button, so it lands in the same place as ConnectButton.vue's picker
     - instead of a button-width to the side of it — see
     - .beacon-player-popover in assets/base.css, which also explains why
     - the location strategy has to be static for that to hold. -->
    <v-menu
      v-else
      :close-on-content-click="false"
      location-strategy="static"
      content-class="beacon-player-popover"
    >
      <template #activator="{ props: menuProps }">
        <v-btn
          :icon="volumeIcon"
          variant="text"
          density="comfortable"
          :title="$t('player.volume')"
          v-bind="menuProps"
        />
      </template>
      <v-card min-width="220" class="volume-popover">
        <v-card-text class="toolbar__popover-row">
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
            @start="onVolumeDragStart"
            @end="onVolumeDragEnd"
            @wheel="onVolumeWheel"
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
            @wheel="onVolumeWheel"
          />
          <span class="text-body-small text-medium-emphasis volume-value">{{
            volumePercentLabel
          }}</span>
        </v-card-text>
      </v-card>
    </v-menu>
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useDrawersStore } from '@/stores/drawers'
import { useConnectStore } from '@/stores/connect'
import { pollingAllowed } from '@/services/connect/pollGate'
import {
  acceptsVolumeReading,
  endVolumeDrag,
  noteVolumeChange,
  startVolumeDrag,
} from '@/services/connect/volumeGuard'
import { useAuthStore } from '@/stores/auth'
import { useAutoplayStore } from '@/stores/autoplay'
import ConnectButton from '@/components/connect/ConnectButton.vue'
import RemoteControlButton from '@/components/settings/RemoteControlButton.vue'
import { volumeAfterWheel } from '@/services/volumeWheel'
import {
  knownDeviceVolume,
  recordDeviceVolume,
  toggleMute as toggleVolumeMute,
} from '@/services/volumeControl'
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
      // Polling fallback for types connectStore.isVolumePushCapable()
      // doesn't cover - those have no channel for "someone changed it on
      // the device itself/another session" other than asking again. Left
      // null and unused for push-capable types (see pushedDeviceVolume).
      volumePollTimer: null as ReturnType<typeof setInterval> | null,
      // Scroll that hasn't added up to a whole volume step yet — see
      // volumeAfterWheel().
      volumeWheelCarry: 0,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    drawersStore() {
      return useDrawersStore()
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
    radioStation() {
      return this.playbackStore.radioStation
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
    // Pushed reading for push-capable types (Sonos today - see
    // connectStore.isVolumePushCapable()'s own comment), null for
    // everything else (and whenever nothing's pushed a reading yet), which
    // the watcher below simply ignores rather than overwriting a real value
    // with nothing.
    pushedDeviceVolume(): number | null {
      const target = this.singleActiveTarget
      return target ? this.connectStore.pushedVolumeFor(target.type, target.name) : null
    },
    // The reading volumeControl.ts holds for this device — how a change
    // made from the keyboard (M, the volume keys) reaches this slider
    // without waiting for the next poll or push.
    sharedDeviceVolume(): number | null {
      const target = this.singleActiveTarget
      return target ? knownDeviceVolume(target) : null
    },
  },
  watch: {
    singleActiveTargetKey: {
      immediate: true,
      handler() {
        this.deviceVolume = null
        clearInterval(this.volumePollTimer ?? undefined)
        this.volumePollTimer = null
        // Not just "a target is active": AirPlay has no per-device volume
        // endpoint (see connectStore.isVolumeCapable()), so asking for one
        // — once, let alone every 4s — can only ever come back empty.
        if (
          this.singleActiveTarget &&
          this.connectStore.isVolumeCapable(this.singleActiveTarget.type)
        ) {
          // Still needed for every type, push-capable included: a push
          // channel only ever fires on the *next* change, so the very
          // first paint still needs one real round trip.
          this.fetchDeviceVolume(this.singleActiveTarget)
          if (
            !this.connectStore.isVolumePushCapable(
              this.singleActiveTarget.type,
              this.singleActiveTarget.name,
            )
          ) {
            // Skipped while the window is hidden or the app is being
            // denied by whatever sits in front of the backend — see
            // pollGate.ts. The timer keeps ticking rather than being torn
            // down and rebuilt, so the reading resumes on its own.
            this.volumePollTimer = setInterval(() => {
              if (this.singleActiveTarget && pollingAllowed()) {
                this.fetchDeviceVolume(this.singleActiveTarget)
              }
            }, 4000)
          }
        }
      },
    },
    pushedDeviceVolume(value: number | null) {
      const target = this.singleActiveTarget
      if (value != null && target && acceptsVolumeReading(target)) this.deviceVolume = value
    },
    // No guard here: this one *is* the user's own change, arriving from the
    // keyboard shortcuts or the mute button via volumeControl.ts.
    sharedDeviceVolume(value: number | null) {
      if (value != null) this.deviceVolume = value
    },
  },
  beforeUnmount() {
    clearInterval(this.volumePollTimer ?? undefined)
  },
  methods: {
    async fetchDeviceVolume(target: ConnectDeviceRef) {
      // Not even asked for while the user is setting it: the answer would
      // be the value from before their change either way.
      if (!acceptsVolumeReading(target)) return
      const raw = await this.connectStore.getDeviceVolume(target.type, target.name)
      // Checked again on the way back — a drag can start while this is in
      // flight, and this answer predates it.
      if (!acceptsVolumeReading(target)) return
      this.deviceVolume = raw == null ? null : Math.round(raw)
      // Handed over so a keyboard step doesn't repeat this round trip (and
      // so it works off a current reading rather than a stale one) — see
      // volumeControl.ts.
      if (this.deviceVolume != null) recordDeviceVolume(target, this.deviceVolume)
    },
    async onDeviceVolumeChange(value: number) {
      const target = this.singleActiveTarget
      if (!target) return
      const rounded = Math.round(value)
      noteVolumeChange(target)
      this.deviceVolume = rounded
      recordDeviceVolume(target, rounded)
      await this.connectStore.setDeviceVolume(target.type, target.name, rounded)
    },
    onVolumeDragStart() {
      if (this.singleActiveTarget) startVolumeDrag(this.singleActiveTarget)
    },
    onVolumeDragEnd() {
      if (this.singleActiveTarget) endVolumeDrag(this.singleActiveTarget)
    },
    // Same branch toggleMute() makes: with exactly one cast target this
    // slider is that device's, otherwise it's local playback's.
    onVolumeWheel(event: WheelEvent) {
      const target = this.singleActiveTarget
      const current = target ? this.deviceVolume : this.playbackStore.volume
      // A disabled slider (a device with no volume support, local playback
      // while casting) leaves the wheel to whatever is scrollable behind it.
      if (current == null || (!target && this.playbackStore.isCasting)) return
      event.preventDefault()
      const { volume, carry } = volumeAfterWheel(
        event,
        current,
        target ? 100 : 1,
        this.volumeWheelCarry,
      )
      this.volumeWheelCarry = carry
      if (volume == null) return
      if (target) void this.onDeviceVolumeChange(volume)
      else this.playbackStore.setVolume(volume)
    },
    // Shared with the M shortcut rather than implemented here (see
    // volumeControl.ts): the pre-mute volume has to be one value, or
    // muting with the key and un-muting with this button restores
    // something the user never set. The slider follows along through
    // sharedDeviceVolume above.
    async toggleMute() {
      await toggleVolumeMute()
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
  display: flex;
  align-items: center;
  gap: 4px;
  justify-self: end;
}

/* The device-volume popover's one row: a slider and its readout. */
.toolbar__popover-row {
  display: flex;
  align-items: center;
  gap: 8px;
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
