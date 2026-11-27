import { defineComponent } from 'vue'
import { useConnectStore } from '@/stores/connect'
import { pollingAllowed } from '@/services/connect/pollGate'
import { acceptsVolumeReading } from '@/services/connect/volumeGuard'
import { groupLevel } from '@/services/groupVolume'
import { knownDeviceVolume, recordDeviceVolume, volumeScope } from '@/services/volumeControl'
import type { ConnectStatusTarget } from '@/services/connect/types'

/**
 * Keeps the master volume's readings current while something shows it -
 * the desktop bar (PlayerToolbar.vue), the phone's
 * (MobileTransportControls.vue) and the cast menu (ConnectDevicePicker.vue,
 * which also tracks a single speaker by overriding volumeTrackedTargets). Same reading rules as their single-device
 * slider: one fetch per speaker to start with, then pushes where the device
 * sends them and a 4s poll where it doesn't. Every reading lands in
 * volumeControl.ts's shared map, which the master and the device lists'
 * own sliders all read from.
 */
export const groupVolumeMixin = defineComponent({
  data() {
    return {
      groupVolumePollTimer: null as ReturnType<typeof setInterval> | null,
    }
  },
  computed: {
    /** Set while two or more speakers are being cast to. */
    volumeGroup(): ConnectStatusTarget[] | null {
      // Read here so the computed follows target changes - volumeScope()
      // itself is a plain function.
      void useConnectStore().activeTargets
      return volumeScope().group
    },
    /** The speakers whose readings are kept current. */
    volumeTrackedTargets(): ConnectStatusTarget[] {
      return this.volumeGroup ?? []
    },
    // A string rather than the array: the targets are parsed fresh from
    // every status tick, so watching the array would refetch every ~2s.
    volumeTrackedKey(): string {
      return this.volumeTrackedTargets.map((t) => `${t.type}:${t.name}`).join('|')
    },
    groupVolumeLevel(): number | null {
      return this.volumeGroup ? groupLevel(this.volumeGroup.map(knownDeviceVolume)) : null
    },
    groupPushedVolumes(): (number | null)[] {
      const connect = useConnectStore()
      return this.volumeTrackedTargets.map((t) => connect.pushedVolumeFor(t.type, t.name))
    },
  },
  watch: {
    volumeTrackedKey: {
      immediate: true,
      handler() {
        clearInterval(this.groupVolumePollTimer ?? undefined)
        this.groupVolumePollTimer = null
        const group = this.volumeTrackedTargets
        if (!group.length) return
        void this.fetchGroupVolumes(group)
        const connect = useConnectStore()
        const polled = group.filter((t) => !connect.isVolumePushCapable(t.type, t.name))
        if (polled.length) {
          this.groupVolumePollTimer = setInterval(() => {
            if (pollingAllowed()) void this.fetchGroupVolumes(polled)
          }, 4000)
        }
      },
    },
    groupPushedVolumes: {
      immediate: true,
      handler(values: (number | null)[]) {
        this.volumeTrackedTargets.forEach((target, i) => {
          const value = values[i]
          if (value != null && acceptsVolumeReading(target)) recordDeviceVolume(target, value)
        })
      },
    },
  },
  beforeUnmount() {
    clearInterval(this.groupVolumePollTimer ?? undefined)
  },
  methods: {
    async fetchGroupVolumes(targets: ConnectStatusTarget[]) {
      const connect = useConnectStore()
      await Promise.all(
        targets.map(async (target) => {
          // Not while it is being set, and checked again on the way back -
          // same as the single-device slider's fetch.
          if (!acceptsVolumeReading(target)) return
          const raw = await connect.getDeviceVolume(target.type, target.name)
          if (raw != null && acceptsVolumeReading(target)) {
            recordDeviceVolume(target, Math.round(raw))
          }
        }),
      )
    },
  },
})
