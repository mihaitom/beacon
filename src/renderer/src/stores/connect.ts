import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { getDiscover } from '@/services/connect/discovery'
import { join, claim, deviceStop } from '@/services/connect/devices'
import {
  getDeviceVolume as apiGetDeviceVolume,
  setDeviceVolume as apiSetDeviceVolume,
} from '@/services/connect/volume'
import {
  listPaired,
  startPairing as apiStartPairing,
  finishPairing as apiFinishPairing,
  unpair as apiUnpair,
} from '@/services/connect/pairing'
import { stop as apiStop } from '@/services/connect/playback'
import { ConnectEventSource } from '@/services/connect/events'
import { ConnectApiError } from '@/services/connect/http'
import { isDeviceInUseError } from '@/services/connect/types'
import type {
  ConnectDeviceRef,
  ConnectStatus,
  ConnectStatusTarget,
  DeviceType,
  DiscoverResponse,
} from '@/services/connect/types'

interface ConnectErrors {
  apiUnreachable: boolean
  authError: boolean
  ffmpegMissing: boolean
  message: string | null
}

interface ConnectState {
  devices: DiscoverResponse
  status: ConnectStatus | null
  paired: string[]
  isScanning: boolean
  connected: boolean
  errors: ConnectErrors
  pendingTakeover: { device: ConnectDeviceRef; owner: string; retry: () => Promise<void> } | null
}

let eventSource: ConnectEventSource | null = null

// eventSource lives outside Pinia's reactive state, so Vite's partial HMR
// doesn't reset/preserve it consistently on a live edit — see playback.ts's
// identical accept()+invalidate() for the full story (this SSE stream is
// exactly what feeds playback.ts's status.ended detection while casting).
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot!.invalidate(
      'stores/connect.ts holds singleton state that cannot be safely hot-reloaded',
    )
  })
}

export const useConnectStore = defineStore('connect', {
  state: (): ConnectState => ({
    devices: { airplay: [], chromecast: [], dlna: [], sonos: [] },
    status: null,
    paired: [],
    isScanning: false,
    connected: false,
    errors: { apiUnreachable: false, authError: false, ffmpegMissing: false, message: null },
    pendingTakeover: null,
  }),

  getters: {
    activeTargets(state): ConnectStatusTarget[] {
      return state.status?.targets ?? []
    },
    isActive(): boolean {
      return this.activeTargets.length > 0
    },
    // Which device types push their volume/mute into `status.targets`
    // instead of only ever needing to be polled for it - a
    // RenderingControl subscription for Sonos (see
    // connect/routes/upnp.py), nothing yet for chromecast/dlna.
    // Centralized here so every surface showing a device's volume
    // (DeviceListItem.vue, MobileDeviceRow.vue, PlayerToolbar.vue,
    // MobileTransportControls.vue, remoteControl.ts's own poll) agrees on
    // which types that applies to, rather than each re-implementing its
    // own `type !== 'sonos'` check - three of those drifted out of sync
    // with the original fix that way (kept polling every 4s for Sonos
    // regardless), caught live 2026-08-25.
    isVolumePushCapable() {
      return (type: DeviceType): boolean => type === 'sonos'
    },
    // The pushed reading for a specific device, or null when its type
    // isn't push-capable, or when nothing has pushed one yet (an unclaimed
    // device, or a claimed one whose first reading hasn't landed - see
    // ConnectStatusTarget.volume's own comment).
    pushedVolumeFor() {
      return (type: DeviceType, name: string): number | null => {
        if (!this.isVolumePushCapable(type)) return null
        const target = this.activeTargets.find((t) => t.type === type && t.name === name)
        return target?.volume ?? null
      }
    },
  },

  actions: {
    async withTakeoverHandling(action: (force: boolean) => Promise<void>): Promise<void> {
      try {
        await action(false)
        this.errors.message = null
      } catch (error) {
        if (error instanceof ConnectApiError && isDeviceInUseError(error.body)) {
          this.pendingTakeover = {
            device: error.body.device,
            owner: error.body.owner,
            retry: () => action(true),
          }
          return
        }
        this.errors.message = error instanceof Error ? error.message : String(error)
        throw error
      }
    },

    async confirmTakeover(): Promise<void> {
      const pending = this.pendingTakeover
      if (!pending) return
      this.pendingTakeover = null
      try {
        await pending.retry()
        this.errors.message = null
        // Without this, the device list still shows the pre-takeover
        // owner/song until something else happens to trigger a refresh
        // (opening the picker again, the next background rescan) — the
        // whole point of a takeover is that it's now claimed by *this*
        // session, so that should be reflected immediately.
        await this.refreshDevices()
      } catch (error) {
        // CastTakeoverConfirmDialog.vue calls this from a bare @click with
        // no await/catch of its own, so this must handle its own failure —
        // without it, a failed forced retry (device went offline, someone
        // else claimed it in the meantime) just closed the dialog with no
        // feedback at all.
        this.errors.message = error instanceof Error ? error.message : String(error)
      }
    },

    cancelTakeover(): void {
      this.pendingTakeover = null
    },

    async refreshDevices(fresh = false): Promise<void> {
      // Only a real rescan (fresh=true, the picker's "Scan again" button)
      // flips this — it drives the picker's progress bar. The cheap
      // fresh=false refreshes (ConnectDevicePicker.vue's 4s background
      // poll, confirmTakeover() above) just re-annotate the already-cached
      // list and shouldn't flash a "scanning" indicator on every tick; that
      // used to make the whole device list visibly jitter every 4s.
      if (fresh) this.isScanning = true
      try {
        this.devices = await getDiscover(fresh)
        this.errors.apiUnreachable = false
      } catch (error) {
        this.errors.apiUnreachable = true
        this.errors.message = error instanceof Error ? error.message : String(error)
      } finally {
        if (fresh) this.isScanning = false
      }
    },

    async joinDevice(target: ConnectDeviceRef): Promise<void> {
      await this.withTakeoverHandling((force) => join(target, force))
    },

    async claimDevices(targets: ConnectDeviceRef[]): Promise<void> {
      await this.withTakeoverHandling((force) => claim(targets, force))
    },

    async stopDevice(deviceType: DeviceType, name: string): Promise<void> {
      await deviceStop(deviceType, name)
    },

    async stopAll(): Promise<void> {
      await apiStop()
    },

    async getDeviceVolume(deviceType: DeviceType, name: string): Promise<number | null> {
      try {
        return await apiGetDeviceVolume(deviceType, name)
      } catch {
        return null // e.g. DLNA renderer without volume support — see routes/volume.py
      }
    },

    async setDeviceVolume(deviceType: DeviceType, name: string, volume: number): Promise<void> {
      await apiSetDeviceVolume(deviceType, name, volume)
    },

    async refreshPaired(): Promise<void> {
      this.paired = await listPaired()
    },

    async startPairing(name: string, force = false) {
      return apiStartPairing(name, force)
    },

    async finishPairing(name: string, pin?: number): Promise<void> {
      await apiFinishPairing(name, pin)
      await this.refreshPaired()
      // /discover's needs_pairing is now credential-aware (see routes/
      // discovery.py's _annotate_claims) — without this, the device stays
      // shown as unpaired until the next periodic/background rescan picks
      // up the credential this pairing just saved.
      await this.refreshDevices()
    },

    async unpair(name: string): Promise<void> {
      await apiUnpair(name)
      await this.refreshPaired()
      await this.refreshDevices()
    },

    /** Bulk counterpart to unpair() — used by SettingsView.vue's "reset
     * AirPlay pairings" action. Refreshes first since nothing proactively
     * loads `paired` before this or the device picker asks for it, so it
     * could still be stale/empty at this point. */
    async unpairAll(): Promise<void> {
      await this.refreshPaired()
      await Promise.all(this.paired.map((name) => apiUnpair(name)))
      await this.refreshPaired()
      await this.refreshDevices()
    },

    subscribeEvents(): void {
      if (eventSource) return
      const auth = useAuthStore()
      // /events is a connect-native route (see services/connect/http.ts's
      // identical apiUrl usage) — nginx injects X-Connect-Token on this too
      // in the web build, even though EventSource can't set custom headers
      // itself (see events.ts's own comment on why session still travels
      // via query param regardless).
      eventSource = new ConnectEventSource(auth.apiUrl, auth.connectToken, auth.sessionId)
      eventSource.onStatus = (status) => {
        this.status = status
      }
      eventSource.onConnectionChange = (connected) => {
        this.connected = connected
      }
      eventSource.start()
    },

    unsubscribeEvents(): void {
      eventSource?.stop()
      eventSource = null
      this.status = null
      this.connected = false
    },

    /** Called from authStore.logout() — App.vue's authenticated watcher
     * already calls unsubscribeEvents() separately (clearing status/
     * connected), but devices/paired/errors/pendingTakeover would otherwise
     * linger from the just-ended session. Concretely: `devices` entries
     * carry in_use_by_session_id from *this* session's own now-cleared
     * authStore.sessionId — without a reset, a device this session was
     * just casting to would misleadingly read as "claimed by someone
     * else" (comparing against sessionId === '') until the next natural
     * refresh. Doesn't stop an active cast — a physical speaker doesn't
     * care which account is signed into this window, same reasoning as
     * playbackStore.resetForLogout(). */
    resetForLogout(): void {
      this.$reset()
    },
  },
})
