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
    activeTargets(state): ConnectDeviceRef[] {
      return state.status?.targets ?? []
    },
    isActive(): boolean {
      return this.activeTargets.length > 0
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
      this.isScanning = true
      try {
        this.devices = await getDiscover(fresh)
        this.errors.apiUnreachable = false
      } catch (error) {
        this.errors.apiUnreachable = true
        this.errors.message = error instanceof Error ? error.message : String(error)
      } finally {
        this.isScanning = false
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
    },

    async unpair(name: string): Promise<void> {
      await apiUnpair(name)
      await this.refreshPaired()
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
  },
})
