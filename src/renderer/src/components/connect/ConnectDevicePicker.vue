<template>
  <v-card min-width="380" max-width="420" class="connect-picker">
    <v-toolbar
      density="compact"
      color="#0B0D13"
      class="connect-picker__toolbar"
      :title="$t('connect.playingOn')"
    >
      <template #append>
        <v-icon
          v-if="connectStore.isActive"
          icon="mdi-cast-connected"
          color="primary"
          size="18"
          class="mr-3 connect-picker__active-glow"
        />
      </template>
    </v-toolbar>
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

      <div
        v-if="allDevices.length === 0 && !connectStore.isScanning"
        class="text-body-medium text-medium-emphasis pa-2"
      >
        {{ $t('connect.noDevicesFound') }}
      </div>

      <!-- Local playback as a real entry rather than "nothing ticked",
       - matching MobileDevicePicker.vue, which has had one all along.
       - Since the stream-info section below now describes local playback
       - too, the card needed something for it to refer to — a panel
       - explaining a format with no visible sign of what is playing it
       - reads as belonging to whichever device is listed first. -->
      <button
        type="button"
        class="this-device"
        :class="{ 'this-device--active': !connectStore.isActive }"
        :aria-pressed="!connectStore.isActive"
        @click="playHere"
      >
        <v-icon
          :icon="connectStore.isActive ? 'mdi-laptop' : 'mdi-circle-slice-8'"
          :color="connectStore.isActive ? undefined : 'primary'"
          size="small"
        />
        {{ $t('connect.thisDevice') }}
      </button>

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
          @volume-change="onVolumeChange"
        />
      </template>

      <v-divider v-if="showStreamInfo" class="my-2" />
      <stream-info-section />
    </v-card-text>
    <v-card-actions class="connect-picker__actions">
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
        v-if="hasPendingChanges && selectedKeys.size > 0"
        size="small"
        color="primary"
        :loading="connecting"
        :disabled="connecting"
        @click="connectSelected"
      >
        {{ applyLabel }}
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
import StreamInfoSection, { hasStreamInfo } from './StreamInfoSection.vue'
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
  components: { ConnectErrorBanner, DeviceListItem, AirplayPairingDialog, StreamInfoSection },
  data() {
    return {
      selectedKeys: new Set<string>(),
      connecting: false,
      // What the active target set was when this picker last synced itself.
      // The diff against selectedKeys is what "is there anything to apply"
      // means, and it also lets an outside change (another client casting,
      // a device dropping) re-seed the checkboxes while the user has not
      // touched them — see syncFromActiveTargets().
      appliedKeys: new Set<string>(),
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
    // Whether stream-info-section actually renders anything below the
    // divider — see hasStreamInfo()'s own comment (StreamInfoSection.vue)
    // for why that answer lives there rather than being re-derived here.
    showStreamInfo(): boolean {
      return hasStreamInfo()
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
    activeKeys(): string[] {
      return this.connectStore.activeTargets.map(
        (t: { name: string; type: string }) => `${t.type}:${t.name}`,
      )
    },
    /** True once the checked set differs from what is actually casting —
     * i.e. there is something for the apply button to do. Covers removals
     * as well as additions, which is the whole point of applying as one
     * step (see playbackStore.applyTargets()). */
    /** Whether the checked set has been touched since it was last seeded
     * from reality. Distinct from hasPendingChanges(): after applying,
     * both go false; while an outside change lands mid-edit, only this one
     * stays true and protects the in-progress selection. */
    userHasEdited(): boolean {
      if (this.appliedKeys.size !== this.selectedKeys.size) return true
      return [...this.selectedKeys].some((key) => !this.appliedKeys.has(key))
    },
    hasPendingChanges(): boolean {
      const active = new Set(this.activeKeys)
      if (active.size !== this.selectedKeys.size) return true
      return [...this.selectedKeys].some((key) => !active.has(key))
    },
    /** Unticking everything is a removal like any other, but it needs no
     * button of its own: the destructive "Stop all" next to this one
     * already says exactly that, and showing both read as two different
     * actions. So this only labels the case where something stays playing. */
    applyLabel(): string {
      return this.connectStore.isActive ? this.$t('connect.apply') : this.$t('connect.connect')
    },
  },
  watch: {
    // Re-seed while the user has no unapplied edits, so the checkboxes keep
    // reflecting reality (another client casting, a device dropping out)
    // without ever discarding a selection someone is in the middle of
    // making.
    activeKeys: {
      immediate: true,
      handler() {
        if (!this.userHasEdited) this.syncFromActiveTargets()
      },
    },
  },
  mounted() {
    // Keeps in_use_by_name/in_use_by_song fresh while the picker is open —
    // someone else's cast session changing songs, or a device becoming
    // free again, should show up without the user having to hit "Scan
    // again". Cheap: this omits fresh=true, so the backend just re-derives
    // claim/song annotations for the already-cached device list (see
    // routes/discovery.py's _annotate_claims()) rather than doing a real
    // mDNS/SSDP rescan — same 4s cadence as DeviceListItem.vue's volume poll.
    this.devicesPollTimer = setInterval(() => this.connectStore.refreshDevices(), 4000)
  },
  beforeUnmount() {
    if (this.devicesPollTimer) clearInterval(this.devicesPollTimer)
  },
  methods: {
    syncFromActiveTargets() {
      this.selectedKeys = new Set(this.activeKeys)
      this.appliedKeys = new Set(this.activeKeys)
    },
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
        // Not castTo(): the checked set is the desired *end state*, and on
        // an already-running session castTo() would replace the targets
        // rather than reconcile them. See applyTargets()'s own docstring.
        await usePlaybackStore().applyTargets(targets)
        this.syncFromActiveTargets()
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
    /** Bring playback back to this device. Same call as "Stop all" — the
     * two differ in what they say, not in what they do: stopping every
     * cast target *is* playing here. Kept separate so the affordance reads
     * as "play here" rather than as a destructive action, and it's a no-op
     * when nothing is casting. */
    async playHere() {
      if (!this.connectStore.isActive) return
      await this.connectStore.stopAll()
    },
    openPairing(name: string) {
      this.pairingDeviceName = name
      this.pairingOpen = true
    },
    async onVolumeChange({
      type,
      device,
      volume,
    }: {
      type: DeviceType
      device: DiscoveredDevice
      volume: number
    }) {
      await this.connectStore.setDeviceVolume(type, device.name, volume)
    },
  },
}
</script>

<style scoped>
/* Same dark-chrome system as QueueDrawer.vue/LyricsDrawer.vue's own
 * .beacon-drawer/.beacon-drawer__toolbar (Vue scoped styles don't share
 * across components just by reusing a class name, so this redeclares it
 * rather than actually reusing theirs) — this floats the same way those
 * do (a v-menu popover, not docked), so the same "reads as part of the
 * app's own chrome, not a generic Material card" treatment applies. */
.connect-picker {
  border: 1px solid var(--beacon-hairline);
}

.connect-picker__toolbar {
  border-bottom: 1px solid var(--beacon-hairline);
}

.connect-picker__active-glow {
  filter: drop-shadow(0 0 5px rgba(245, 169, 78, 0.5));
}

.connect-picker__actions {
  border-top: 1px solid var(--beacon-hairline);
}

.device-group-heading {
  padding: 8px 12px 4px;
}

/* Deliberately built to DeviceListItem.vue's own .device-row measurements
 * (46px min-height, 4px 12px padding, the same hover tint and lit edge)
 * rather than reusing that component: this row has no volume slider, no
 * claim state and no checkbox — a props-driven variant of it would be more
 * branching than the twenty lines below. Scoped styles don't cross
 * components anyway, so either way the values are restated. */
.this-device {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 46px;
  padding: 4px 12px;
  margin-bottom: 4px;
  border-radius: 4px;
  font-size: 0.875rem;
  text-align: left;
  transition: background 0.1s;
}

.this-device:hover {
  background: var(--beacon-hover);
}

.this-device--active {
  position: relative;
  background: rgba(var(--v-theme-primary), 0.08);
}

.this-device--active:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}

/* The same beam the active cast target gets — playing here is a state
 * worth marking as clearly as playing on a speaker. */
.this-device--active::before {
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

.this-device--active .v-icon {
  filter: drop-shadow(0 0 5px rgba(245, 169, 78, 0.4));
}
</style>
