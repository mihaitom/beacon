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
import { connectErrorMessage } from '@/services/connect/errorMessage'
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
  /** The raw text behind `message` where there is one — see
   * services/connect/errorMessage.ts. Shown under the message in smaller
   * type rather than folded into it: a listener reads the sentence, and
   * whoever they ask about it reads this. */
  detail: string | null
}

interface ConnectState {
  devices: DiscoverResponse
  status: ConnectStatus | null
  paired: string[]
  isScanning: boolean
  /** Whether a device list has ever come back. Gates the "first scan"
   * half of isScanning below — deliberately not derived from `devices`
   * being non-empty, since a network with genuinely no speakers on it
   * completes a real scan with four empty lists. */
  hasScanned: boolean
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
    hasScanned: false,
    connected: false,
    errors: {
      apiUnreachable: false,
      authError: false,
      ffmpegMissing: false,
      message: null,
      detail: null,
    },
    pendingTakeover: null,
  }),

  getters: {
    activeTargets(state): ConnectStatusTarget[] {
      return state.status?.targets ?? []
    },
    isActive(): boolean {
      return this.activeTargets.length > 0
    },
    // Which device types report a real, trustworthy position for radio
    // while casting — see connect/core/radio_position.py. AirPlay is
    // excluded even though it supports position for *tracks*: it has none
    // to poll for radio at all. Sonos included since 2026-09-02: its own
    // http:// radio dispatch already gives it a real, live-polled position
    // (see delivery/sonos.py's own comment) — no ICY marker injection
    // needed. Centralized here for the same reason as
    // isVolumePushCapable() above — NowPlayingView.vue's visualizerAvailable
    // is the one consumer today, but any second one should agree with it
    // rather than growing its own copy of this set.
    isRadioPositionCapable() {
      return (type: DeviceType): boolean =>
        type === 'chromecast' || type === 'dlna' || type === 'sonos'
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
    // Which device types have a per-device volume endpoint at all (see
    // connect/routes/volume.py's /device-volume, which answers with a
    // plain "not supported" error for anything else). Centralized here for
    // the same reason as isVolumePushCapable() above: DeviceListItem.vue,
    // MobileDeviceRow.vue and MobileTransportControls.vue each carried
    // their own copy of this set, and each one's *fetch* forgot to consult
    // it - an active AirPlay target was polled every 4s for a reading that
    // could never come back and was never shown.
    isVolumeCapable() {
      return (type: DeviceType): boolean =>
        type === 'sonos' || type === 'chromecast' || type === 'dlna'
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
    /** Records a failure in the one shape ConnectDevicePicker.vue renders.
     * Centralized rather than stringified at each call site, so a
     * classified delivery failure reads as a real sentence everywhere
     * rather than only wherever someone remembered to translate it — see
     * services/connect/errorMessage.ts. */
    setError(error: unknown): void {
      const { message, detail } = connectErrorMessage(error)
      this.errors.message = message
      this.errors.detail = detail
    },

    clearError(): void {
      this.errors.message = null
      this.errors.detail = null
    },

    async withTakeoverHandling(action: (force: boolean) => Promise<void>): Promise<void> {
      try {
        await action(false)
        this.clearError()
      } catch (error) {
        if (error instanceof ConnectApiError && isDeviceInUseError(error.body)) {
          this.pendingTakeover = {
            device: error.body.device,
            owner: error.body.owner,
            retry: () => action(true),
          }
          return
        }
        this.setError(error)
        throw error
      }
    },

    async confirmTakeover(): Promise<void> {
      const pending = this.pendingTakeover
      if (!pending) return
      this.pendingTakeover = null
      try {
        await pending.retry()
        this.clearError()
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
        this.setError(error)
      }
    },

    cancelTakeover(): void {
      this.pendingTakeover = null
    },

    async refreshDevices(fresh = false): Promise<void> {
      // Two things count as "scanning" for the UI, both of which really do
      // keep the caller waiting on a full SSDP/mDNS sweep:
      //   - an explicit rescan (fresh=true, the pickers' rescan button)
      //   - the very first refresh of the session (App.vue fires one on
      //     login). The backend has no device cache yet then, so even this
      //     fresh=false call blocks for the whole scan (see routes/
      //     discovery.py's has_cache branch) — several seconds during which
      //     the pickers used to sit on "No devices found" with no sign that
      //     anything was still happening.
      // Every later fresh=false refresh (ConnectDevicePicker.vue's 4s
      // background poll, confirmTakeover() above) only re-annotates the
      // already-cached list and must not flash an indicator on every tick;
      // that used to make the whole device list visibly jitter every 4s.
      const showProgress = fresh || !this.hasScanned
      if (showProgress) this.isScanning = true
      try {
        this.devices = await getDiscover(fresh)
        // Only on success: while every attempt so far has failed, the next
        // one is still the first real scan as far as the user is concerned.
        this.hasScanned = true
        this.errors.apiUnreachable = false
      } catch (error) {
        this.errors.apiUnreachable = true
        this.setError(error)
      } finally {
        if (showProgress) this.isScanning = false
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
        // The one failure that never had a request to answer: a device
        // that accepted what it was given and then reported on its own
        // event channel that it isn't playing it, with nothing left for
        // the backend to try (see connect/routes/upnp.py). Without this
        // the speaker just goes quiet and the UI still says "playing".
        // A one-shot flag on a single broadcast, exactly like
        // `interrupted` — set it once, here, where each new payload
        // arrives, rather than anywhere that re-reads the same payload.
        if (status.delivery_error) {
          this.setError(new ConnectApiError('delivery_failed', status.delivery_error))
        }
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
