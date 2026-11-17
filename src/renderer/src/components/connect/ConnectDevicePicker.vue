<template>
  <v-card class="connect-picker">
    <header class="connect-picker__head">
      <v-icon
        :icon="connectStore.isActive ? 'mdi-cast-connected' : 'mdi-cast'"
        :color="connectStore.isActive ? 'primary' : undefined"
        size="20"
        :class="{ 'connect-picker__active-glow': connectStore.isActive }"
      />
      <span class="connect-picker__title">{{ $t('connect.playingOn') }}</span>
    </header>

    <div v-if="hasNotices" class="connect-picker__notices">
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
        @click:close="connectStore.clearError()"
      >
        {{ connectStore.errors.message }}
        <div v-if="connectStore.errors.detail" class="connect-error-detail">
          {{ connectStore.errors.detail }}
        </div>
      </v-alert>
    </div>

    <!-- Two halves: what is playing, with its volumes, and what could be
     - added. The menu's height follows the speakers in use rather than
     - every one the network has. -->
    <div class="connect-picker__body">
      <section class="connect-picker__playing">
        <div v-if="connectStore.isActive" class="eyebrow-label connect-picker__heading">
          {{ playingHeading }}
        </div>
        <segmented-control
          v-if="showModeSwitch"
          class="connect-picker__mode"
          dense
          :model-value="groupVolumeStore.mode"
          :options="modeOptions"
          :label="$t('connect.groupVolume')"
          @update:model-value="onModeChange"
        />

        <template v-if="connectStore.isActive">
          <volume-fader
            v-if="volumeGroup"
            master
            class="connect-picker__fader"
            :label="$t('connect.allSpeakers')"
            :model-value="groupVolumeLevel"
            :floor="groupVolumeStore.mode === 'relative' ? groupVolumeFloor : null"
            @update:model-value="onMasterChange"
            @start="volumeGroup.forEach(startVolumeDrag)"
            @end="volumeGroup.forEach(endVolumeDrag)"
          >
            <template #icon><v-icon icon="mdi-speaker-multiple" size="20" /></template>
          </volume-fader>
          <volume-fader
            v-for="target in connectStore.activeTargets"
            :key="`${target.type}:${target.name}`"
            class="connect-picker__fader"
            :label="target.name"
            :model-value="deviceLevel(target)"
            :adjustable="connectStore.isVolumeCapable(target.type)"
            :plain="perSpeakerPlain || !connectStore.isVolumeCapable(target.type)"
            :remove-label="$t('connect.removeSpeaker', { name: target.name })"
            @update:model-value="onDeviceChange(target, $event)"
            @start="startVolumeDrag(target)"
            @end="endVolumeDrag(target)"
            @remove="remove(target)"
          >
            <template #icon>
              <airplay-icon v-if="target.type === 'airplay'" />
              <v-icon v-else :icon="typeIcon(target.type)" size="20" />
            </template>
          </volume-fader>
          <button type="button" class="connect-picker__local" @click="playHere">
            <v-icon icon="mdi-laptop" size="19" />
            {{ $t('connect.playHereInstead') }}
          </button>
        </template>
        <div v-else class="connect-picker__here">
          <v-icon icon="mdi-laptop" size="20" color="primary" />
          <span class="text-body-medium">{{ $t('connect.thisDevice') }}</span>
        </div>

        <stream-info-section class="connect-picker__stream-info" />
      </section>

      <section class="connect-picker__available">
        <div class="eyebrow-label connect-picker__heading">{{ $t('connect.addHeading') }}</div>
        <!-- No separate progress bar: the rescan button below carries the
         - spinner, and this line is the only place an empty list needs to
         - say anything at all. It covers the first scan after login too,
         - which blocks for the full sweep (see refreshDevices()). -->
        <div v-if="availableGroups.length === 0" class="text-body-small connect-picker__empty">
          {{
            connectStore.isScanning
              ? $t('connect.searchingDevices')
              : allDevicesCount === 0
                ? $t('connect.noDevicesFound')
                : $t('connect.allInUse')
          }}
        </div>
        <template v-for="group in availableGroups" :key="group.type">
          <div class="text-body-small connect-picker__type">{{ group.label }}</div>
          <available-device-row
            v-for="entry in group.entries"
            :key="`${entry.type}:${entry.device.name}`"
            :device="entry.device"
            :type="entry.type"
            :busy="busyKey === `${entry.type}:${entry.device.name}`"
            @add="add(entry)"
            @take-over="takeOver(entry)"
            @pair="openPairing(entry.device.name)"
          />
        </template>
      </section>
    </div>

    <footer class="connect-picker__actions">
      <v-btn
        class="connect-picker__rescan"
        size="small"
        variant="text"
        :loading="connectStore.isScanning"
        :disabled="connectStore.isScanning"
        @click="connectStore.refreshDevices(true)"
      >
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
    </footer>

    <airplay-pairing-dialog v-model="pairingOpen" :device-name="pairingDeviceName" />
  </v-card>
</template>

<script lang="ts">
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { useGroupVolumeStore } from '@/stores/groupVolume'
import { pollingAllowed } from '@/services/connect/pollGate'
import { endVolumeDrag, startVolumeDrag } from '@/services/connect/volumeGuard'
import {
  knownDeviceVolume,
  sendDeviceVolume,
  setVolume,
  volumeScope,
} from '@/services/volumeControl'
import { groupVolumeMixin } from '@/components/player/groupVolumeMixin'
import SegmentedControl, { type SegmentedOption } from '@/components/SegmentedControl.vue'
import ConnectErrorBanner from './ConnectErrorBanner.vue'
import AirplayPairingDialog from './AirplayPairingDialog.vue'
import AirplayIcon from './AirplayIcon.vue'
import AvailableDeviceRow, { TYPE_ICONS } from './AvailableDeviceRow.vue'
import VolumeFader from './VolumeFader.vue'
import StreamInfoSection from './StreamInfoSection.vue'
import type { GroupVolumeMode } from '@/services/groupVolume'
import type {
  ConnectDeviceRef,
  ConnectStatusTarget,
  DeviceType,
  DiscoveredDevice,
} from '@/services/connect/types'

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
  components: {
    AirplayIcon,
    AirplayPairingDialog,
    AvailableDeviceRow,
    ConnectErrorBanner,
    SegmentedControl,
    StreamInfoSection,
    VolumeFader,
  },
  mixins: [groupVolumeMixin],
  data() {
    return {
      // The speaker being added right now, for its row's spinner.
      busyKey: null as string | null,
      pairingOpen: false,
      pairingDeviceName: '',
      devicesPollTimer: null as ReturnType<typeof setInterval> | null,
    }
  },
  computed: {
    connectStore() {
      return useConnectStore()
    },
    authStore() {
      return useAuthStore()
    },
    groupVolumeStore() {
      return useGroupVolumeStore()
    },
    /** Every speaker in use, a single one included - its row is a slider
     * here too. See groupVolumeMixin. */
    volumeTrackedTargets(): ConnectStatusTarget[] {
      return this.connectStore.activeTargets.filter((t) =>
        this.connectStore.isVolumeCapable(t.type),
      )
    },
    hasNotices(): boolean {
      return (
        this.connectStore.errors.apiUnreachable ||
        this.authStore.health?.ffmpeg === false ||
        !!this.connectStore.errors.message
      )
    },
    /** Under the menu's own "Playing on", so just the count. */
    playingHeading(): string {
      const count = this.connectStore.activeTargets.length
      return count === 1
        ? this.$t('connect.oneSpeaker')
        : this.$t('connect.speakerCount', { n: count })
    },
    /** With fewer than two speakers that have a volume, both modes do the
     * same thing. */
    showModeSwitch(): boolean {
      return this.volumeTrackedTargets.length > 1
    },
    modeOptions(): SegmentedOption[] {
      return [
        { title: this.$t('connect.groupVolumeEqual'), value: 'equal' },
        { title: this.$t('connect.groupVolumeRelative'), value: 'relative' },
      ]
    },
    /** In 'equal' mode the master is the only level there is, so the
     * speakers' rows are names only. */
    perSpeakerPlain(): boolean {
      return !!this.volumeGroup && this.groupVolumeStore.mode === 'equal'
    },
    groupVolumeFloor(): number | null {
      const levels = (this.volumeGroup ?? [])
        .map(knownDeviceVolume)
        .filter((level): level is number => level != null)
      return levels.length ? Math.min(...levels) : null
    },
    activeKeys(): Set<string> {
      return new Set(this.connectStore.activeTargets.map((t) => `${t.type}:${t.name}`))
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
    allDevicesCount(): number {
      return this.deviceGroups.reduce((sum, group) => sum + group.entries.length, 0)
    },
    /** What could still be added - the speakers in use are on the left. */
    availableGroups(): DeviceGroup[] {
      return this.deviceGroups
        .map((group) => ({
          ...group,
          entries: group.entries.filter((e) => !this.activeKeys.has(this.key(e))),
        }))
        .filter((group) => group.entries.length > 0)
    },
  },
  mounted() {
    // Keeps in_use_by_name/in_use_by_song fresh while the picker is open —
    // someone else's cast session changing songs, or a device becoming
    // free again, should show up without the user having to hit "Scan
    // again". Cheap: this omits fresh=true, so the backend just re-derives
    // claim/song annotations for the already-cached device list (see
    // routes/discovery.py's _annotate_claims()) rather than doing a real
    // mDNS/SSDP rescan.
    // Not while the window is hidden or the app is being denied by
    // whatever sits in front of the backend — see pollGate.ts. Nobody can
    // be watching a picker in a hidden window, and a re-annotation nothing
    // renders is the kind of steady baseline that keeps a ban alive.
    this.devicesPollTimer = setInterval(() => {
      if (pollingAllowed()) void this.connectStore.refreshDevices()
    }, 4000)
  },
  beforeUnmount() {
    if (this.devicesPollTimer) clearInterval(this.devicesPollTimer)
  },
  methods: {
    startVolumeDrag,
    endVolumeDrag,
    key(entry: DeviceEntry): string {
      return `${entry.type}:${entry.device.name}`
    },
    typeIcon(type: DeviceType): string {
      return TYPE_ICONS[type] ?? 'mdi-speaker'
    },
    deviceLevel(target: ConnectDeviceRef): number | null {
      return knownDeviceVolume(target)
    },
    onModeChange(mode: string) {
      this.groupVolumeStore.setMode(mode as GroupVolumeMode)
    },
    onMasterChange(level: number) {
      void setVolume(volumeScope(), level)
    },
    onDeviceChange(target: ConnectDeviceRef, level: number) {
      // Not awaited per move - see services/connect/volumeWrite.ts.
      sendDeviceVolume({ type: target.type, name: target.name }, level)
    },
    /**
     * Adds a speaker to what is playing, straight away. Through
     * applyTargets() rather than castTo(): on a running session that
     * replaces the targets instead of adding to them, and with nothing
     * running applyTargets() starts the cast itself.
     */
    async add(entry: DeviceEntry) {
      if (this.busyKey) return
      this.busyKey = this.key(entry)
      try {
        await usePlaybackStore().applyTargets([
          ...this.connectStore.activeTargets,
          { type: entry.type, name: entry.device.name },
        ])
      } catch {
        // A device-in-use conflict already opened the takeover dialog (see
        // castTo()/withTakeoverHandling()); any other failure already set
        // connectStore.errors.message, shown above.
      } finally {
        this.busyKey = null
      }
    },
    /** Claim a device another session is holding, *in addition to*
     * whatever is already playing. */
    async takeOver(entry: DeviceEntry) {
      const target = { name: entry.device.name, type: entry.type }
      try {
        await usePlaybackStore().applyTargets([...this.connectStore.activeTargets, target], true)
      } catch {
        // Already recorded on connectStore.errors and shown above.
      }
    },
    /** One speaker stops; the rest keep playing. The last one hands back
     * to this device, same as "Stop all". */
    async remove(target: ConnectDeviceRef) {
      const rest = this.connectStore.activeTargets.filter(
        (t) => !(t.type === target.type && t.name === target.name),
      )
      try {
        await usePlaybackStore().applyTargets(rest)
      } catch {
        // Already recorded on connectStore.errors and shown above.
      }
    },
    async stopAll() {
      await this.connectStore.stopAll()
    },
    /** Bring playback back to this device. Same call as "Stop all" — the
     * two differ in what they say, not in what they do: stopping every
     * cast target *is* playing here. */
    async playHere() {
      if (!this.connectStore.isActive) return
      await this.connectStore.stopAll()
    },
    openPairing(name: string) {
      this.pairingDeviceName = name
      this.pairingOpen = true
    },
  },
}
</script>

<style scoped>
.connect-picker {
  /* Two columns want room; a narrow window still gets the whole menu,
   * stacked (see the container query below). */
  width: min(800px, calc(100vw - 16px));
  display: flex;
  flex-direction: column;
  max-height: inherit;
  border: 1px solid var(--beacon-hairline);
  container-type: inline-size;
}

.connect-picker__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px 10px;
}

.connect-picker__title {
  font-size: 1rem;
  font-weight: 600;
}

.connect-picker__active-glow {
  filter: drop-shadow(0 0 6px rgba(var(--v-theme-primary), 0.55));
}

.connect-picker__notices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 14px 8px;
}

.connect-error-detail {
  margin-top: 4px;
  font-size: 0.75rem;
  opacity: 0.7;
  word-break: break-word;
}

.connect-picker__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  min-height: 0;
  flex: 1;
}

.connect-picker__playing,
.connect-picker__available {
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 10px;
}

.connect-picker__playing {
  display: flex;
  flex-direction: column;
  padding-inline: 10px;
}

.connect-picker__available {
  padding-inline: 8px;
  border-left: 1px solid var(--beacon-hairline);
  background: rgba(0, 0, 0, 0.12);
}

.connect-picker__heading {
  padding: 10px 8px 8px;
}

/* Local playback, playing: lit the way a speaker's row is. */
.connect-picker__here {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 48px;
  margin-top: 8px;
  padding: 0 12px;
  border-radius: 10px;
  background: rgba(var(--v-theme-primary), 0.08);
  font-weight: 500;
}

.connect-picker__here::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 0 10px 1px rgba(var(--v-theme-primary), 0.55);
}

.connect-picker__mode {
  margin: 0 0 8px;
}

.connect-picker__fader {
  margin-bottom: 4px;
}

.connect-picker__fader.fader--master {
  margin-bottom: 8px;
}

.connect-picker__local {
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 42px;
  margin-top: 4px;
  padding: 0 12px;
  border-radius: 10px;
  color: rgba(var(--v-theme-on-surface), 0.7);
  text-align: left;
}

.connect-picker__local:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}

.connect-picker__local:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}

/* At the foot of its half, under however many speakers there are. */
.connect-picker__stream-info {
  margin-top: auto;
  padding: 16px 8px 0;
}

.connect-picker__type {
  padding: 10px 8px 4px;
  font-weight: 600;
  color: rgba(var(--v-theme-on-surface), 0.45);
}

.connect-picker__empty {
  padding: 4px 8px;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.connect-picker__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  border-top: 1px solid var(--beacon-hairline);
}

@container (max-width: 620px) {
  .connect-picker__body {
    grid-template-columns: minmax(0, 1fr);
    overflow-y: auto;
  }

  .connect-picker__playing,
  .connect-picker__available {
    overflow: visible;
  }

  .connect-picker__available {
    border-left: none;
    border-top: 1px solid var(--beacon-hairline);
  }
}
</style>
