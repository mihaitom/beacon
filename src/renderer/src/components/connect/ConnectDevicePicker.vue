<template>
  <v-card min-width="380" max-width="420">
    <v-toolbar density="compact" :title="$t('connect.title')" />
    <v-card-text>
      <connect-error-banner
        v-if="connectStore.errors.apiUnreachable"
        variant="api-unreachable"
        @retry="connectStore.refreshDevices(true)"
      />
      <connect-error-banner v-if="authStore.health?.ffmpeg === false" variant="ffmpeg-missing" />
      <v-alert
        v-if="connectStore.errors.message"
        type="error"
        variant="tonal"
        density="compact"
        closable
        class="mb-2"
        @click:close="connectStore.errors.message = null"
      >
        {{ connectStore.errors.message }}
      </v-alert>

      <v-progress-linear v-if="connectStore.isScanning" indeterminate class="mb-2" />

      <div v-if="allDevices.length === 0 && !connectStore.isScanning" class="text-body-2 text-medium-emphasis pa-2">
        {{ $t('connect.noDevicesFound') }}
      </div>

      <template v-for="group in deviceGroups" :key="group.type">
        <div class="eyebrow-label device-group-heading">{{ group.label }}</div>
        <device-list-item
          v-for="entry in group.entries"
          :key="`${entry.type}:${entry.device.name}`"
          :device="entry.device"
          :type="entry.type"
          :selected="selectedKeys.has(`${entry.type}:${entry.device.name}`)"
          @update:selected="toggleSelected(entry, $event)"
          @take-over="takeOver(entry)"
          @pair="openPairing(entry.device.name)"
          @stop="connectStore.stopDevice(entry.type, entry.device.name)"
          @volume-change="onVolumeChange"
        />
      </template>
    </v-card-text>
    <v-card-actions>
      <v-btn size="small" variant="text" @click="connectStore.refreshDevices(true)">
        {{ $t('connect.rescan') }}
      </v-btn>
      <v-spacer />
      <v-btn
        v-if="connectStore.isActive"
        size="small"
        variant="text"
        color="error"
        @click="stopAll"
      >
        {{ $t('connect.stopAll') }}
      </v-btn>
      <v-btn
        v-if="selectedKeys.size > 0"
        size="small"
        color="primary"
        :loading="connecting"
        :disabled="connecting"
        @click="connectSelected"
      >
        {{
          connectStore.isActive
            ? $t('connect.addN', { count: selectedKeys.size })
            : $t('connect.connect')
        }}
      </v-btn>
    </v-card-actions>

    <airplay-pairing-dialog v-model="pairingOpen" :device-name="pairingDeviceName" />
  </v-card>
</template>

<script lang="ts">
import { useConnectStore } from '@/stores/connect'
import { useAuthStore } from '@/stores/auth'
import { usePlaybackStore } from '@/stores/playback'
import ConnectErrorBanner from './ConnectErrorBanner.vue'
import DeviceListItem from './DeviceListItem.vue'
import AirplayPairingDialog from './AirplayPairingDialog.vue'
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

// Fixed display order (not alphabetical) — Sonos/AirPlay are this app's
// primary, best-supported casting targets.
const TYPE_ORDER: DeviceType[] = ['sonos', 'airplay', 'chromecast', 'dlna']
const TYPE_LABELS: Record<DeviceType, string> = {
  sonos: 'Sonos',
  airplay: 'AirPlay',
  chromecast: 'Chromecast',
  dlna: 'DLNA',
}

export default {
  name: 'ConnectDevicePicker',
  components: { ConnectErrorBanner, DeviceListItem, AirplayPairingDialog },
  data() {
    return {
      selectedKeys: new Set<string>(),
      connecting: false,
      pairingOpen: false,
      pairingDeviceName: '',
    }
  },
  computed: {
    connectStore() {
      return useConnectStore()
    },
    authStore() {
      return useAuthStore()
    },
    // Grouped by type (fixed order, see TYPE_ORDER) with each group sorted
    // alphabetically by name — the per-device type label this replaced is
    // gone from DeviceListItem.vue since the group heading already says it.
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
  methods: {
    toggleSelected(entry: DeviceEntry, value: boolean) {
      const key = `${entry.type}:${entry.device.name}`
      if (value) this.selectedKeys.add(key)
      else this.selectedKeys.delete(key)
      // Set isn't deeply reactive-triggering on add/delete alone in all cases — force refresh.
      this.selectedKeys = new Set(this.selectedKeys)
    },
    async connectSelected() {
      this.connecting = true
      try {
        const targets = this.allDevices
          .filter((e) => this.selectedKeys.has(`${e.type}:${e.device.name}`))
          .map((e) => ({ name: e.device.name, type: e.type }))
        await usePlaybackStore().castTo(targets)
        this.selectedKeys = new Set()
      } catch {
        // A device-in-use conflict already opened the takeover dialog (see
        // castTo()/withTakeoverHandling()); any other failure already set
        // connectStore.errors.message, shown via the v-alert above — this
        // catch just stops it from becoming an unhandled rejection.
      } finally {
        this.connecting = false
      }
    },
    async takeOver(entry: DeviceEntry) {
      await usePlaybackStore().castTo([{ name: entry.device.name, type: entry.type }], true)
    },
    async stopAll() {
      await this.connectStore.stopAll()
    },
    openPairing(name: string) {
      this.pairingDeviceName = name
      this.pairingOpen = true
    },
    async onVolumeChange({ type, device, volume }: { type: DeviceType; device: DiscoveredDevice; volume: number }) {
      await this.connectStore.setDeviceVolume(type, device.name, volume)
    },
  },
}
</script>

<style scoped>
.device-group-heading {
  padding: 8px 12px 4px;
}
</style>
