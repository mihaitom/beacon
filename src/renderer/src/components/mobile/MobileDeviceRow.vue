<template>
  <div class="mobile-device-row">
    <div
      class="mobile-device-row__main"
      :class="{ 'mobile-device-row__main--disabled': needsPairing }"
      @click="onRowClick"
    >
      <airplay-icon v-if="type === 'airplay'" class="mobile-device-row__type-icon" />
      <v-icon v-else :icon="typeIcon" size="20" />

      <div class="mobile-device-row__info min-width-0">
        <div class="text-body-medium">{{ device.name }}</div>
        <div v-if="needsPairing" class="text-body-small text-medium-emphasis">
          {{ $t('mobile.needsPairing') }}
        </div>
        <div v-else-if="claimedByOther" class="text-body-small device-row__claimed">
          {{
            device.in_use_by_name
              ? $t('connect.inUseBy', { name: device.in_use_by_name })
              : $t('connect.inUseByUnknown')
          }}
        </div>
      </div>

      <!-- Explicit button, not "tap the row" — taking a speaker from
       - someone is a deliberate action. -->
      <v-btn
        v-if="claimedByOther"
        size="small"
        variant="tonal"
        color="error"
        prepend-icon="mdi-swap-horizontal"
        @click.stop="$emit('take-over')"
      >
        {{ $t('connect.takeOver') }}
      </v-btn>
      <v-icon v-else-if="selected" icon="mdi-check-circle" color="primary" />
    </div>

    <!-- Always visible (no hover on touch) for every currently active,
     - volume-capable target — same rule the LAN remote's devices.js already
     - validated. Not with several speakers in 'equal' mode, where the
     - master is the only level there is. -->
    <div v-if="showVolume" class="mobile-device-row__volume">
      <v-icon icon="mdi-volume-high" size="18" class="mobile-device-row__volume-icon" />
      <touch-volume-slider
        :model-value="volume ?? 0"
        :max="100"
        :disabled="volume == null"
        :aria-label="$t('player.volume')"
        @update:model-value="onVolumeInput"
        @commit="onVolumeCommit"
      />
      <span class="text-body-small text-medium-emphasis mobile-device-row__volume-value">{{
        volume != null ? `${volume}%` : '–'
      }}</span>
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useConnectStore } from '@/stores/connect'
import { pollingAllowed } from '@/services/connect/pollGate'
import {
  acceptsVolumeReading,
  endVolumeDrag,
  noteVolumeChange,
} from '@/services/connect/volumeGuard'
import { writeDeviceVolume } from '@/services/connect/volumeWrite'
import { useAuthStore } from '@/stores/auth'
import TouchVolumeSlider from './TouchVolumeSlider.vue'
import { knownDeviceVolume, recordDeviceVolume, volumeScope } from '@/services/volumeControl'
import { useGroupVolumeStore } from '@/stores/groupVolume'
import AirplayIcon from '@/components/connect/AirplayIcon.vue'
import type { ConnectDeviceRef, DeviceType } from '@/services/connect/types'

const TYPE_ICONS: Record<string, string> = {
  chromecast: 'mdi-cast',
  dlna: 'mdi-television-classic',
  sonos: 'mdi-speaker-wireless',
}

export default {
  name: 'MobileDeviceRow',
  components: { AirplayIcon, TouchVolumeSlider },
  props: {
    device: {
      type: Object,
      required: true,
    },
    type: {
      type: String as PropType<DeviceType>,
      required: true,
    },
    selected: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['toggle', 'take-over'],
  data() {
    return {
      volume: null as number | null,
      volumePollTimer: null as ReturnType<typeof setInterval> | null,
    }
  },
  computed: {
    /** This row's device as the volume guard and the connect store name
     * it — see services/connect/volumeGuard.ts. */
    deviceRef(): ConnectDeviceRef {
      return { type: this.type, name: this.device.name }
    },

    connectStore() {
      return useConnectStore()
    },
    typeIcon() {
      return TYPE_ICONS[this.type] ?? 'mdi-speaker'
    },
    claimedByOther() {
      return (
        this.device.in_use_by_session_id != null &&
        this.device.in_use_by_session_id !== useAuthStore().sessionId
      )
    },
    // No pairing flow on the mobile view either — same reasoning as the LAN
    // remote's devices.js (there's no PIN-entry UI here), shown disabled
    // with an explanation instead of just vanishing from the list.
    needsPairing() {
      return this.type === 'airplay' && this.device.needs_pairing
    },
    isMyActiveTarget() {
      return this.connectStore.activeTargets.some(
        (t: { name: string; type: string }) => t.name === this.device.name && t.type === this.type,
      )
    },
    showVolume() {
      // See connectStore.isVolumeCapable().
      if (!this.isMyActiveTarget || !this.connectStore.isVolumeCapable(this.type)) return false
      return !(volumeScope().group && useGroupVolumeStore().mode === 'equal')
    },
    // Pushed reading for push-capable types (Sonos today - see
    // connectStore.isVolumePushCapable()'s own comment), null for
    // everything else (and whenever nothing's pushed a reading yet), which
    // the watcher below simply ignores rather than overwriting a real value
    // with nothing.
    pushedVolume(): number | null {
      return this.connectStore.pushedVolumeFor(this.type, this.device.name)
    },
    // Where the master and the volume keys report what they just set -
    // see services/volumeControl.ts.
    sharedVolume(): number | null {
      return knownDeviceVolume(this.deviceRef)
    },
  },
  watch: {
    // showVolume, not isMyActiveTarget: a type without a volume endpoint
    // was polled every 4s for a reading that could never come back and had
    // nowhere to be shown anyway.
    showVolume: {
      immediate: true,
      handler(canShow: boolean) {
        clearInterval(this.volumePollTimer ?? undefined)
        this.volumePollTimer = null
        if (canShow) {
          // Still needed for every type, push-capable included: a push
          // channel only ever fires on the *next* change, so the very
          // first paint still needs one real round trip.
          this.fetchVolume()
          if (!this.connectStore.isVolumePushCapable(this.type, this.device.name)) {
            // Skipped while the window is hidden or the app is being
            // denied by whatever sits in front of the backend — see
            // pollGate.ts. The timer keeps ticking rather than being torn
            // down and rebuilt, so the reading resumes on its own.
            this.volumePollTimer = setInterval(() => {
              if (pollingAllowed()) this.fetchVolume()
            }, 4000)
          }
        }
      },
    },
    pushedVolume(value: number | null) {
      // See services/connect/volumeGuard.ts — a reading must not land on
      // top of a drag in progress.
      if (value != null && acceptsVolumeReading(this.deviceRef)) {
        this.volume = value
        recordDeviceVolume(this.deviceRef, value)
      }
    },
    // No guard: this is the user's own change, made somewhere else.
    sharedVolume(value: number | null) {
      if (value != null) this.volume = value
    },
  },
  beforeUnmount() {
    clearInterval(this.volumePollTimer ?? undefined)
  },
  methods: {
    onRowClick() {
      // claimedByOther has its own explicit "Take over" button above instead
      // — a plain row tap there would either do nothing (confusing, no
      // feedback) or take over accidentally on what was meant as a glance,
      // neither of which matches deliberately tapping a dedicated button.
      if (this.needsPairing || this.claimedByOther) return
      this.$emit('toggle')
    },
    async fetchVolume() {
      if (!acceptsVolumeReading(this.deviceRef)) return
      const raw = await this.connectStore.getDeviceVolume(this.type, this.device.name)
      if (!acceptsVolumeReading(this.deviceRef)) return
      this.volume = raw == null ? null : Math.round(raw)
      // Shared so the master in the player bar starts from it.
      if (this.volume != null) recordDeviceVolume(this.deviceRef, this.volume)
    },
    /** Moves the slider and nothing else — the speaker is told on release,
     * same as MobileTransportControls.vue's own slider explains at length.
     * Each move holds the guard open; a native range has no drag start to
     * do it once. */
    onVolumeInput(value: number) {
      this.volume = Math.round(value)
      noteVolumeChange(this.deviceRef)
    },
    onVolumeCommit(value: number) {
      const rounded = Math.round(value)
      this.volume = rounded
      endVolumeDrag(this.deviceRef)
      noteVolumeChange(this.deviceRef)
      recordDeviceVolume(this.deviceRef, rounded)
      writeDeviceVolume(this.deviceRef, rounded, (volume) =>
        this.connectStore.setDeviceVolume(this.type, this.device.name, volume),
      )
    },
  },
}
</script>

<style scoped>
.mobile-device-row {
  border-radius: 8px;
}

.mobile-device-row__main {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 52px;
  padding: 6px 16px;
}

.mobile-device-row__main--disabled {
  opacity: 0.45;
}

.mobile-device-row__info {
  flex: 1;
}

.mobile-device-row__type-icon {
  font-size: 20px;
}

.device-row__claimed {
  color: rgb(var(--v-theme-info, 91, 132, 177));
}

.mobile-device-row__volume {
  display: flex;
  align-items: center;
  padding: 0 16px 10px 50px;
}

.mobile-device-row__volume-value {
  width: 32px;
  text-align: right;
}

.min-width-0 {
  min-width: 0;
}

/* A device's name and status each stay on one line. */
.mobile-device-row__info > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-device-row__volume-icon {
  margin-right: 8px;
}
</style>
