import { defineComponent } from 'vue'
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
import type { SegmentedOption } from '@/components/SegmentedControl.vue'
import { TYPE_ICONS } from './AvailableDeviceRow.vue'
import type { GroupVolumeMode } from '@/services/groupVolume'
import type {
  ConnectDeviceRef,
  ConnectStatusTarget,
  DeviceType,
  DiscoveredDevice,
} from '@/services/connect/types'

export interface DeviceEntry {
  device: DiscoveredDevice
  type: DeviceType
}

export interface DeviceGroup {
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

/**
 * What the cast menu does, shared by its two layouts: the desktop's
 * two-pane popover (ConnectDevicePicker.vue) and the phone's sheet
 * (MobileDevicePicker.vue). A tap adds or stops a speaker straight away;
 * nothing is staged behind an apply button on either.
 */
export const castMenuMixin = defineComponent({
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
    /** What could still be added - the speakers in use are listed apart. */
    availableGroups(): DeviceGroup[] {
      return this.deviceGroups
        .map((group) => ({
          ...group,
          entries: group.entries.filter((e) => !this.activeKeys.has(this.key(e))),
        }))
        .filter((group) => group.entries.length > 0)
    },
    /** The one line an empty "Add" list has to say. */
    emptyAvailableText(): string {
      if (this.connectStore.isScanning) return this.$t('connect.searchingDevices')
      return this.allDevicesCount === 0
        ? this.$t('connect.noDevicesFound')
        : this.$t('connect.allInUse')
    },
  },
  mounted() {
    // Keeps in_use_by_name/in_use_by_song fresh while the menu is open —
    // someone else's cast session changing songs, or a device becoming
    // free again, should show up without the user having to hit "Scan
    // again". Cheap: this omits fresh=true, so the backend just re-derives
    // claim/song annotations for the already-cached device list (see
    // routes/discovery.py's _annotate_claims()) rather than doing a real
    // mDNS/SSDP rescan.
    // Not while the window is hidden or the app is being denied by
    // whatever sits in front of the backend — see pollGate.ts. Nobody can
    // be watching a menu in a hidden window, and a re-annotation nothing
    // renders is the kind of steady baseline that keeps a ban alive.
    this.devicesPollTimer = setInterval(() => {
      if (pollingAllowed() && this.menuShown()) void this.connectStore.refreshDevices()
    }, 4000)
  },
  beforeUnmount() {
    if (this.devicesPollTimer) clearInterval(this.devicesPollTimer)
  },
  methods: {
    startVolumeDrag,
    endVolumeDrag,
    /** Whether anybody can see the menu - the phone's sheet stays mounted
     * while closed. */
    menuShown(): boolean {
      return true
    },
    /** A failure that left nothing on connectStore.errors for the menu's
     * own alert to show. */
    reportCastError(): void {},
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
        // connectStore.errors.message, shown in the menu's alert.
        this.reportCastError()
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
        this.reportCastError()
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
        this.reportCastError()
      }
    },
    async stopAll() {
      await this.connectStore.stopAll()
    },
    /** Bring playback back to this device and carry on playing here -
     * unlike "Stop all", which leaves it paused. */
    async playHere() {
      try {
        await usePlaybackStore().playHere()
      } catch {
        this.reportCastError()
      }
    },
    openPairing(name: string) {
      this.pairingDeviceName = name
      this.pairingOpen = true
    },
  },
})
