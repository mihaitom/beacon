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
        <div class="text-body-medium text-truncate">{{ device.name }}</div>
        <div v-if="needsPairing" class="text-body-small text-medium-emphasis text-truncate">
          {{ $t('mobile.needsPairing') }}
        </div>
        <div v-else-if="claimedByOther" class="text-body-small device-row__claimed text-truncate">
          {{
            device.in_use_by_name
              ? $t('connect.inUseBy', { name: device.in_use_by_name })
              : $t('connect.inUseByUnknown')
          }}
        </div>
      </div>

      <!-- Explicit button, not "tap the row" — same deliberate-action shape
       - as DeviceListItem.vue's own "Take over" button, just always visible
       - here instead of hover-revealed (no touch equivalent to hover). -->
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

    <!-- Always visible (unlike DeviceListItem.vue's hover-accordion, which
     - has no touch equivalent) for every currently active, volume-capable
     - target — same rule the LAN remote's devices.js already validated. -->
    <div v-if="showVolume" class="mobile-device-row__volume">
      <v-icon icon="mdi-volume-high" size="18" class="mr-2" />
      <v-slider
        :model-value="volume ?? 0"
        :max="100"
        :step="1"
        :disabled="volume == null"
        density="compact"
        hide-details
        style="flex: 1"
        @update:model-value="onVolumeChange"
        @start="onVolumeDragStart"
        @end="onVolumeDragEnd"
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
  startVolumeDrag,
} from '@/services/connect/volumeGuard'
import { useAuthStore } from '@/stores/auth'
import AirplayIcon from '@/components/connect/AirplayIcon.vue'
import type { ConnectDeviceRef, DeviceType } from '@/services/connect/types'

const TYPE_ICONS: Record<string, string> = {
  chromecast: 'mdi-cast',
  dlna: 'mdi-television-classic',
  sonos: 'mdi-speaker-wireless',
}

export default {
  name: 'MobileDeviceRow',
  components: { AirplayIcon },
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
      // AirPlay/RAOP has no per-device volume endpoint — same gate
      // DeviceListItem.vue uses, see connectStore.isVolumeCapable().
      return this.isMyActiveTarget && this.connectStore.isVolumeCapable(this.type)
    },
    // Pushed reading for push-capable types (Sonos today - see
    // connectStore.isVolumePushCapable()'s own comment), null for
    // everything else (and whenever nothing's pushed a reading yet), which
    // the watcher below simply ignores rather than overwriting a real value
    // with nothing.
    pushedVolume(): number | null {
      return this.connectStore.pushedVolumeFor(this.type, this.device.name)
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
      if (value != null && acceptsVolumeReading(this.deviceRef)) this.volume = value
    },
  },
  beforeUnmount() {
    clearInterval(this.volumePollTimer ?? undefined)
  },
  methods: {
    onVolumeDragStart() {
      startVolumeDrag(this.deviceRef)
    },
    onVolumeDragEnd() {
      endVolumeDrag(this.deviceRef)
    },

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
    },
    async onVolumeChange(value: number) {
      const rounded = Math.round(value)
      noteVolumeChange(this.deviceRef)
      this.volume = rounded
      await this.connectStore.setDeviceVolume(this.type, this.device.name, rounded)
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
</style>
