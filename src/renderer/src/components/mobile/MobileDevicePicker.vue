<template>
  <v-bottom-sheet
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card class="mobile-device-picker">
      <div class="mobile-device-picker__header">
        <span class="text-subtitle-1">{{ $t('mobile.playOn') }}</span>
        <v-spacer />
        <v-btn
          variant="flat"
          size="small"
          :color="selectedKeys.size > 0 ? 'primary' : undefined"
          @click="done"
        >
          {{ $t('common.done') }}
        </v-btn>
      </div>

      <div
        v-if="connectStore.isScanning && allDevices.length === 0"
        class="d-flex justify-center pa-6"
      >
        <v-progress-circular indeterminate color="primary" />
      </div>

      <v-list v-else class="mobile-device-picker__list">
        <v-list-item
          v-if="connectStore.isActive"
          class="mobile-device-picker__disconnect"
          @click="disconnectAll"
        >
          <template #prepend><v-icon icon="mdi-cast-off" /></template>
          <v-list-item-title>{{ $t('connect.stopAll') }}</v-list-item-title>
        </v-list-item>

        <v-list-item @click="disconnectAll">
          <template #prepend><v-icon icon="mdi-speaker" /></template>
          <v-list-item-title>{{ $t('connect.thisDevice') }}</v-list-item-title>
        </v-list-item>

        <template v-for="group in deviceGroups" :key="group.type">
          <v-list-subheader>{{ group.label }}</v-list-subheader>
          <mobile-device-row
            v-for="entry in group.entries"
            :key="`${entry.type}:${entry.device.name}`"
            :device="entry.device"
            :type="entry.type"
            :selected="selectedKeys.has(`${entry.type}:${entry.device.name}`)"
            @toggle="toggle(entry)"
            @take-over="takeOver(entry)"
          />
        </template>

        <div
          v-if="allDevices.length === 0 && !connectStore.isScanning"
          class="text-body-2 text-medium-emphasis pa-4"
        >
          {{ $t('connect.noDevicesFound') }}
        </div>
      </v-list>
    </v-card>
  </v-bottom-sheet>
</template>

<script lang="ts">
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import MobileDeviceRow from './MobileDeviceRow.vue'
import type { DeviceType, DiscoveredDevice } from '@/services/connect/types'

interface DeviceEntry {
  device: DiscoveredDevice
  type: DeviceType
}

interface DeviceGroup {
  type: DeviceType
  label: string
  entries: DeviceEntry[]
}

// Same fixed order/labels as ConnectDevicePicker.vue — keeps "which icon
// means which brand" and the group order reading the same on both surfaces.
const TYPE_ORDER: DeviceType[] = ['sonos', 'airplay', 'chromecast', 'dlna']
const TYPE_LABELS: Record<DeviceType, string> = {
  sonos: 'Sonos',
  airplay: 'AirPlay',
  chromecast: 'Chromecast',
  dlna: 'DLNA',
}

export default {
  name: 'MobileDevicePicker',
  components: { MobileDeviceRow },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      // Pre-checked with whatever's already casting, same starting point as
      // DeviceListItem.vue's own `checked` computed. Snapshotted separately
      // as initialKeys so "Done" can tell a genuinely unchanged selection
      // apart from a re-confirmed one — see selectionUnchanged() below and
      // the LAN remote's devices.js, which validated this exact behavior
      // ("Wenn keine Änderung ist, dann soll done nur das overlay
      // schließen.").
      selectedKeys: new Set<string>(),
      initialKeys: new Set<string>(),
    }
  },
  computed: {
    connectStore() {
      return useConnectStore()
    },
    deviceGroups(): DeviceGroup[] {
      const d = this.connectStore.devices
      const byType: Record<DeviceType, DiscoveredDevice[]> = {
        sonos: d.sonos,
        airplay: d.airplay,
        chromecast: d.chromecast,
        dlna: d.dlna,
      }
      return TYPE_ORDER.map((type) => ({
        type,
        label: TYPE_LABELS[type],
        entries: [...byType[type]]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((device) => ({ device, type })),
      })).filter((group) => group.entries.length > 0)
    },
    allDevices(): DeviceEntry[] {
      return this.deviceGroups.flatMap((group) => group.entries)
    },
  },
  watch: {
    modelValue(open: boolean) {
      if (!open) return
      void this.connectStore.refreshDevices()
      const activeKeys = this.connectStore.activeTargets.map((t) => `${t.type}:${t.name}`)
      this.selectedKeys = new Set(activeKeys)
      this.initialKeys = new Set(activeKeys)
    },
  },
  methods: {
    key(entry: DeviceEntry): string {
      return `${entry.type}:${entry.device.name}`
    },
    toggle(entry: DeviceEntry) {
      const key = this.key(entry)
      const next = new Set(this.selectedKeys)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      this.selectedKeys = next
    },
    selectionUnchanged(): boolean {
      return (
        this.selectedKeys.size === this.initialKeys.size &&
        [...this.selectedKeys].every((key) => this.initialKeys.has(key))
      )
    },
    // Releases every active cast target — local playback then picks up on
    // its own (see stores/playback.ts's connect.$subscribe handler), the
    // same underlying action whether triggered from the explicit
    // "Stop all" row (only shown while actually casting) or by picking
    // "This device" itself.
    disconnectAll() {
      void this.connectStore.stopAll()
      this.$emit('update:modelValue', false)
    },
    // Mirrors ConnectDevicePicker.vue's own takeOver() — immediate,
    // single-device, force=true, and deliberately doesn't close the sheet
    // (the row's own state flips once activeTargets updates, same as
    // desktop's hover-button doesn't close its popover either).
    async takeOver(entry: DeviceEntry) {
      await usePlaybackStore().castTo([{ type: entry.type, name: entry.device.name }], true)
    },
    async done() {
      if (!this.selectionUnchanged()) {
        const targets = [...this.selectedKeys].map((key) => {
          const [deviceType, ...rest] = key.split(':')
          return { type: deviceType as DeviceType, name: rest.join(':') }
        })
        // applyTargets(), not castTo(): this picker already collected a
        // desired *end state*, and castTo() would re-dispatch every device
        // in it, including ones already playing. See its own docstring.
        await usePlaybackStore().applyTargets(targets)
      }
      this.$emit('update:modelValue', false)
    },
  },
}
</script>

<style scoped>
.mobile-device-picker__header {
  display: flex;
  align-items: center;
  padding: 16px 16px 8px;
}

/* Destructive action (stops every active cast target) — colored to read
 * that way at a glance, same as ConnectDevicePicker.vue's own "Stop all"
 * button (color="error"). */
.mobile-device-picker__disconnect,
.mobile-device-picker__disconnect :deep(.v-icon) {
  color: rgb(var(--v-theme-error));
}

.mobile-device-picker__list {
  max-height: 60vh;
  overflow-y: auto;
  padding-bottom: env(safe-area-inset-bottom);
}
</style>
