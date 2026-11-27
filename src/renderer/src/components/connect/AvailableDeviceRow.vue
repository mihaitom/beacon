<template>
  <div class="available" :class="{ 'available--blocked': blocked }">
    <!-- A speaker that is not playing here yet. A click adds it straight away;
     - one someone else is using, or an AirPlay device that has to be paired
     - first, offers that step instead. -->
    <button
      type="button"
      class="available__main"
      :disabled="blocked || busy"
      :aria-label="$t('connect.addSpeaker', { name: device.name })"
      @click="$emit('add')"
    >
      <airplay-icon v-if="type === 'airplay'" class="available__icon" />
      <v-icon v-else :icon="typeIcon" size="19" class="available__icon" />
      <span class="available__text">
        <span class="available__name text-body-medium">{{ device.name }}</span>
        <span v-if="claimedByOther" class="available__claimed text-body-small">
          {{
            device.in_use_by_name
              ? $t('connect.inUseBy', { name: device.in_use_by_name })
              : $t('connect.inUseByUnknown')
          }}
        </span>
        <span
          v-if="claimedByOther && device.in_use_by_song"
          class="text-body-small available__song"
        >
          {{ device.in_use_by_song }}
        </span>
      </span>
      <v-progress-circular v-if="busy" indeterminate size="16" width="2" color="primary" />
      <v-icon v-else-if="!blocked" icon="mdi-plus" size="18" class="available__add" />
    </button>
    <v-btn
      v-if="claimedByOther"
      size="small"
      variant="tonal"
      color="error"
      class="available__action"
      @click="$emit('take-over')"
    >
      {{ $t('connect.takeOver') }}
    </v-btn>
    <v-btn
      v-else-if="needsPairing"
      size="small"
      variant="tonal"
      prepend-icon="mdi-key"
      class="available__action"
      @click="$emit('pair')"
    >
      {{ $t('connect.pair') }}
    </v-btn>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useAuthStore } from '@/stores/auth'
import AirplayIcon from './AirplayIcon.vue'
import type { DeviceType, DiscoveredDevice } from '@/services/connect/types'

export const TYPE_ICONS: Record<string, string> = {
  chromecast: 'mdi-cast',
  dlna: 'mdi-television-classic',
  sonos: 'mdi-speaker-wireless',
}

export default {
  name: 'AvailableDeviceRow',
  components: { AirplayIcon },
  props: {
    device: {
      type: Object as PropType<DiscoveredDevice>,
      required: true,
    },
    type: {
      type: String as PropType<DeviceType>,
      required: true,
    },
    busy: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['add', 'take-over', 'pair'],
  computed: {
    typeIcon(): string {
      return TYPE_ICONS[this.type] ?? 'mdi-speaker'
    },
    claimedByOther(): boolean {
      const owner = this.device.in_use_by_session_id
      return owner != null && owner !== useAuthStore().sessionId
    },
    needsPairing(): boolean {
      return this.type === 'airplay' && !!this.device.needs_pairing
    },
    /** Added through its own button instead of a click on the row. */
    blocked(): boolean {
      return this.claimedByOther || this.needsPairing
    },
  },
}
</script>

<style scoped>
.available {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 8px;
}

.available:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}

.available__main {
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 42px;
  padding: 6px 8px;
  border-radius: 8px;
  text-align: left;
  color: inherit;
}

.available__main:not(:disabled) {
  cursor: pointer;
}

.available__main:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}

.available__icon {
  flex: none;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.available__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.available__name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.available__claimed {
  color: rgb(var(--v-theme-error));
}

.available__song {
  color: rgba(var(--v-theme-on-surface), 0.5);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.available__add {
  color: rgb(var(--v-theme-primary));
  opacity: 0;
  transition: opacity 0.15s ease;
}

.available:hover .available__add,
.available__main:focus-visible .available__add {
  opacity: 1;
}

@media (hover: none) {
  .available__add {
    opacity: 1;
  }
}

.available__action {
  flex: none;
  margin-right: 6px;
}
</style>
