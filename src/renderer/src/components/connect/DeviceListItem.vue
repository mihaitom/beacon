<template>
  <div
    class="device-row"
    :class="{ 'device-row--tight': showVolumeSlider, 'device-row--active': isMyActiveTarget }"
  >
    <div class="device-row__main">
      <v-switch
        :model-value="checked"
        :disabled="claimedByOther"
        color="primary"
        density="compact"
        hide-details
        class="device-row__switch"
        @update:model-value="onToggle"
      />

      <airplay-icon
        v-if="type === 'airplay'"
        class="device-row__type-icon"
        :class="{ 'text-primary': isMyActiveTarget }"
      />
      <v-icon v-else :icon="typeIcon" :color="isMyActiveTarget ? 'primary' : undefined" size="20" />

      <div
        class="device-row__info min-width-0"
        :class="{ 'cursor-pointer': !isMyActiveTarget && !claimedByOther }"
        @click="onInfoClick"
      >
        <div class="text-body-2 text-truncate" :class="{ 'text-primary': isMyActiveTarget }">
          {{ device.name }}
        </div>
        <template v-if="claimedByOther">
          <div class="text-caption device-row__claimed text-truncate">
            {{
              device.in_use_by_name
                ? $t('connect.inUseBy', { name: device.in_use_by_name })
                : $t('connect.inUseByUnknown')
            }}
          </div>
          <div
            v-if="device.in_use_by_track"
            class="text-caption text-medium-emphasis text-truncate"
          >
            {{ device.in_use_by_track }}
          </div>
        </template>
      </div>

      <v-btn
        v-if="claimedByOther"
        size="small"
        variant="tonal"
        color="error"
        prepend-icon="mdi-swap-horizontal"
        class="device-row__hover-btn device-row__hover-btn--visible"
        @click="$emit('take-over', device)"
      >
        {{ $t('connect.takeOver') }}
      </v-btn>

      <v-btn
        v-if="showPairButton"
        size="x-small"
        variant="tonal"
        class="device-row__hover-btn"
        prepend-icon="mdi-key"
        @click.stop="$emit('pair', device)"
      >
        {{ $t('connect.pair') }}
      </v-btn>
    </div>

    <div
      v-if="canShowVolume"
      class="device-row__volume"
      :class="{ 'device-row__volume--always': showVolumeSlider }"
    >
      <div class="device-row__volume-inner">
        <v-btn
          :icon="volumeIcon"
          :disabled="volume == null"
          variant="text"
          density="comfortable"
          size="small"
          @click="onToggleMute"
        />
        <v-slider
          :model-value="volume ?? 0"
          :max="100"
          :step="1"
          :disabled="volume == null"
          density="compact"
          hide-details
          style="flex: 1"
          @update:model-value="onVolumeChange"
        />
        <span class="text-caption text-medium-emphasis volume-value">{{ volume != null ? `${volume}%` : '–' }}</span>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useConnectStore } from '@/stores/connect'
import { useAuthStore } from '@/stores/auth'
import AirplayIcon from './AirplayIcon.vue'
import type { DeviceType } from '@/services/connect/types'

// airplay has its own real glyph (AirplayIcon, see the template) — Material
// Design Icons has no "airplay" icon at all (won't carry Apple's
// trademarked logo), so every other type here goes through v-icon/mdi.
const TYPE_ICONS: Record<string, string> = {
  chromecast: 'mdi-cast',
  dlna: 'mdi-television-classic',
  sonos: 'mdi-speaker-wireless',
}

// Airplay/RAOP has no per-device volume endpoint (see connect/routes/volume.py) — only these support it.
const VOLUME_CAPABLE_TYPES = new Set(['sonos', 'chromecast', 'dlna'])

export default {
  name: 'DeviceListItem',
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
  emits: ['update:selected', 'take-over', 'pair', 'stop', 'volume-change'],
  data() {
    return {
      // null while unfetched/unsupported — the slider stays hidden rather
      // than showing a made-up starting value (see fetchVolume()).
      volume: null as number | null,
      volumeBeforeMute: null as number | null,
      // Connect's SSE status has no volume field, so there's no push
      // channel for "someone changed it on the device itself/another
      // session" — polling is the only way this slider ever finds out.
      volumePollTimer: null as ReturnType<typeof setInterval> | null,
    }
  },
  computed: {
    connectStore() {
      return useConnectStore()
    },
    authStore() {
      return useAuthStore()
    },
    typeIcon() {
      return TYPE_ICONS[this.type] ?? 'mdi-speaker'
    },
    claimedByOther() {
      return (
        this.device.in_use_by_session_id != null &&
        this.device.in_use_by_session_id !== this.authStore.sessionId
      )
    },
    isMyActiveTarget() {
      return this.connectStore.activeTargets.some(
        (t: { name: string; type: string }) => t.name === this.device.name && t.type === this.type,
      )
    },
    checked() {
      return this.isMyActiveTarget || this.selected
    },
    canShowVolume() {
      return this.isMyActiveTarget && VOLUME_CAPABLE_TYPES.has(this.type)
    },
    showVolumeSlider() {
      return this.canShowVolume && this.connectStore.activeTargets.length === 1
    },
    showPairButton() {
      return this.type === 'airplay' && this.device.needs_pairing
    },
    volumeIcon() {
      if (this.volume == null) return 'mdi-volume-high'
      return this.volume === 0 ? 'mdi-volume-mute' : 'mdi-volume-medium'
    },
  },
  watch: {
    isMyActiveTarget: {
      immediate: true,
      handler(active: boolean) {
        clearInterval(this.volumePollTimer ?? undefined)
        this.volumePollTimer = null
        if (active) {
          this.fetchVolume()
          this.volumePollTimer = setInterval(() => this.fetchVolume(), 4000)
        }
      },
    },
  },
  beforeUnmount() {
    clearInterval(this.volumePollTimer ?? undefined)
  },
  methods: {
    onToggle() {
      if (this.claimedByOther) return
      if (this.isMyActiveTarget) {
        this.$emit('stop', this.device)
      } else {
        this.$emit('update:selected', !this.selected)
      }
    },
    onInfoClick() {
      if (this.isMyActiveTarget || this.claimedByOther) return
      this.onToggle()
    },
    async fetchVolume() {
      const raw = await this.connectStore.getDeviceVolume(this.type, this.device.name)
      this.volume = raw == null ? null : Math.round(raw)
    },
    onVolumeChange(value: number) {
      const rounded = Math.round(value)
      this.volume = rounded
      this.$emit('volume-change', { device: this.device, type: this.type, volume: rounded })
    },
    onToggleMute() {
      if (this.volume === 0) {
        this.onVolumeChange(this.volumeBeforeMute ?? 50)
      } else {
        this.volumeBeforeMute = this.volume
        this.onVolumeChange(0)
      }
    },
  },
}
</script>

<style scoped>
.device-row {
  position: relative;
  border-radius: 4px;
  margin-bottom: 4px;
  transition: background 0.1s;
}

.device-row--tight {
  margin-bottom: 0;
}

.device-row:hover {
  background: var(--beacon-hover);
}

.device-row--active {
  background: rgba(var(--v-theme-primary), 0.08);
}

.device-row--active:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}

/* Same lit-edge language as DefaultLayout.vue's nav rail (.beacon-rail
 * :deep(.v-list-item--active)::before) — a beam picking this row out
 * instead of a flat Material tint being the only signal that it's the
 * active cast target. */
.device-row--active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 0 10px 1px rgba(245, 169, 78, 0.55);
}

.device-row--active .v-icon,
.device-row--active .device-row__type-icon {
  filter: drop-shadow(0 0 5px rgba(245, 169, 78, 0.4));
}

.device-row__main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 46px;
  padding: 4px 12px;
}

.device-row__switch {
  flex: 0 0 auto;
  margin-right: 12px;
}

.device-row__info {
  flex: 1;
}

.device-row__claimed {
  color: rgb(var(--v-theme-info, 91, 132, 177));
}

.cursor-pointer {
  cursor: pointer;
}

.device-row__hover-btn {
  flex-shrink: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.1s;
}

.device-row:hover .device-row__hover-btn {
  opacity: 1;
  pointer-events: auto;
}

.device-row__hover-btn--visible {
  opacity: 1;
  pointer-events: auto;
}

/* Always open for a single active target; accordion-on-hover otherwise. */
.device-row__volume {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition:
    max-height 0.2s ease,
    opacity 0.15s ease;
}

.device-row:hover .device-row__volume {
  max-height: 44px;
  opacity: 1;
}

.device-row__volume--always {
  max-height: 44px;
  opacity: 1;
}

.device-row__volume-inner {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px 8px 40px;
}

.volume-value {
  width: 32px;
  text-align: right;
}

.min-width-0 {
  min-width: 0;
}

/* Sized up from the v-icon it sits alongside (size="20") — this glyph's own
 * artwork covers noticeably less of its 24x24 viewBox than the MDI icons
 * here do, so matching font-size exactly renders it visibly smaller. */
.device-row__type-icon {
  font-size: 20px;
}
</style>
