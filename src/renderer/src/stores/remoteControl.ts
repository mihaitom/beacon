import { defineStore } from 'pinia'
import {
  enableRemoteControl,
  disableRemoteControl,
  getRemoteControlStatus,
  sendRemoteKeepalive,
  pushRemoteState,
  respondToRemoteQuery,
} from '@/services/remoteControl/http'
import { RemoteAgentEventSource } from '@/services/remoteControl/agent'
import {
  handleRemoteCommand,
  resolveRemoteQuery,
  toRemoteSong,
  remoteRadioFaviconUrl,
} from '@/services/remoteControl/commands'
import { usePlaybackStore } from './playback'
import { useConnectStore } from './connect'
import { useAuthStore } from './auth'

interface RemoteControlState {
  enabled: boolean
  pin: string | null
  // Only ever populated right after *this* session's own enable() call (or
  // a manual regenerate) — deliberately never re-fetched from /status, to
  // minimize how long the plaintext bearer credential exists in memory.
  // refreshStatus() finding the feature already enabled without a locally
  // known password (e.g. after a renderer reload) surfaces as
  // needsRegenerate below instead of trying to recover it.
  password: string | null
  lanIp: string
  port: number
  needsRegenerate: boolean
}

const KEEPALIVE_INTERVAL_MS = 20_000
const STATE_PUSH_DEBOUNCE_MS = 300
// Matches DeviceListItem.vue's own polling interval — connect's SSE status
// has no volume field (nothing pushes "someone changed it on the device
// itself"), so this is the only way either UI ever finds out.
const DEVICE_VOLUME_POLL_INTERVAL_MS = 4_000

let agentSource: RemoteAgentEventSource | null = null
let keepaliveTimer: ReturnType<typeof setInterval> | null = null
let unsubscribePlayback: (() => void) | null = null
let statePushTimer: ReturnType<typeof setTimeout> | null = null
// Set by startStatePush() so startDeviceVolumePoll() below can trigger a
// fresh snapshot push once a poll actually changes the cached value,
// without needing its own separate debounce/push-transport machinery.
let schedulePushSnapshot: (() => void) | null = null
let deviceVolumePollTimer: ReturnType<typeof setInterval> | null = null
// null = either not casting to exactly one device, or the first poll since
// the target changed hasn't resolved yet — see startDeviceVolumePoll().
let deviceVolumeCache: number | null = null

export const useRemoteControlStore = defineStore('remoteControl', {
  state: (): RemoteControlState => ({
    enabled: false,
    pin: null,
    password: null,
    lanIp: '',
    port: 0,
    needsRegenerate: false,
  }),

  getters: {
    /** The address a phone should open/scan — Electron builds ask connect
     * itself for a LAN-reachable address (see connect/core/state.py's
     * get_local_ip()); the web/Docker build has no such backend to ask (its
     * own origin, whatever nginx/domain fronts it, already *is* the address
     * reachable from a phone — see also SettingsView's other window.api
     * branches for the same distinction). Trailing slash is required, not
     * cosmetic — every relative asset reference in index.html resolves
     * against this URL's directory, and routes/remote.py's own redirect from
     * the no-slash form is a fallback for anyone typing it by hand, not
     * something this getter should rely on for its own QR code / copy
     * button. */
    lanUrl(state): string {
      if (window.api) return `http://${state.lanIp}:${state.port}/remote/app/`
      return `${window.location.origin}/remote/app/`
    },
  },

  actions: {
    async enable(): Promise<void> {
      const creds = await enableRemoteControl()
      this.enabled = true
      this.password = creds.password
      this.pin = creds.pin
      this.lanIp = creds.lan_ip
      this.port = creds.port
      this.needsRegenerate = false
      this.startRelay()
    },

    async disable(): Promise<void> {
      try {
        await disableRemoteControl()
      } finally {
        this.enabled = false
        this.password = null
        this.pin = null
        this.needsRegenerate = false
        this.stopRelay()
      }
    },

    /** Called once at app startup (App.vue) — reconciles this store's
     * (freshly-reset) state with connect's actual persisted RemoteState.
     * Needed because connect is a separate long-running process: a plain
     * renderer reload doesn't disable Remote Control server-side, but does
     * reset this Pinia store back to its initial `enabled: false` — without
     * this, the relay (agent SSE, keepalive, state push) would just silently
     * stay down until the user happened to toggle the Settings switch. */
    async refreshStatus(): Promise<void> {
      let status
      try {
        status = await getRemoteControlStatus()
      } catch {
        return // connect not reachable yet — nothing to reconcile
      }
      this.enabled = status.enabled
      this.pin = status.pin
      this.lanIp = status.lan_ip
      this.port = status.port
      if (status.enabled) {
        this.needsRegenerate = !this.password
        this.startRelay()
      }
    },

    startRelay(): void {
      this.startAgent()
      this.startKeepalive()
      this.startStatePush()
      this.startDeviceVolumePoll()
    },

    stopRelay(): void {
      agentSource?.stop()
      agentSource = null
      if (keepaliveTimer) clearInterval(keepaliveTimer)
      keepaliveTimer = null
      unsubscribePlayback?.()
      unsubscribePlayback = null
      if (statePushTimer) clearTimeout(statePushTimer)
      statePushTimer = null
      schedulePushSnapshot = null
      if (deviceVolumePollTimer) clearInterval(deviceVolumePollTimer)
      deviceVolumePollTimer = null
      deviceVolumeCache = null
    },

    startAgent(): void {
      if (agentSource) return
      const auth = useAuthStore()
      agentSource = new RemoteAgentEventSource(auth.apiUrl, auth.connectToken)
      agentSource.onCommand = (message) => {
        void handleRemoteCommand(message.type, message.payload)
      }
      agentSource.onQuery = (message) => {
        void resolveRemoteQuery(message.type, message.payload)
          .then((data) => respondToRemoteQuery(message.request_id, data))
          .catch((error) => console.error('[remoteControl] Failed to answer query:', error))
      }
      agentSource.start()
    },

    startKeepalive(): void {
      if (keepaliveTimer) return
      void sendRemoteKeepalive().catch(() => {})
      keepaliveTimer = setInterval(() => {
        void sendRemoteKeepalive().catch(() => {})
      }, KEEPALIVE_INTERVAL_MS)
    },

    startStatePush(): void {
      if (unsubscribePlayback) return
      const playback = usePlaybackStore()
      const connect = useConnectStore()
      const push = (): void => {
        statePushTimer = null
        const snapshot = {
          playing: playback.isPlaying,
          position: playback.localPosition,
          duration: playback.duration,
          volume: playback.volume,
          shuffle: playback.shuffle,
          repeat: playback.repeatMode,
          current_song: playback.currentSong ? toRemoteSong(playback.currentSong) : null,
          radio: playback.radioStation
            ? {
                name: playback.radioStation.name,
                stream_url: playback.radioStation.streamUrl,
                favicon_url: remoteRadioFaviconUrl(playback.radioStation.homePageUrl, 120),
              }
            : null,
          queue: playback.queue.map(toRemoteSong),
          queue_index: playback.currentIndex,
          casting: connect.activeTargets,
          // Separate from `volume` (always local) rather than overloading
          // it — mirrors PlayerBar.vue's own two distinct sliders
          // (deviceVolume vs playbackStore.volume) exactly, so the phone
          // can tell "no device volume yet" (still polling) apart from
          // "genuinely 0". Only ever non-null with exactly one active
          // target — see startDeviceVolumePoll()'s own comment for why
          // 2+ targets has no single value to report here either.
          device_volume: connect.activeTargets.length === 1 ? deviceVolumeCache : null,
        }
        void pushRemoteState(snapshot).catch(() => {})
      }
      push() // seed connect's snapshot immediately rather than waiting for the first mutation
      const schedulePush = (): void => {
        if (statePushTimer) return
        statePushTimer = setTimeout(push, STATE_PUSH_DEBOUNCE_MS)
      }
      schedulePushSnapshot = schedulePush
      // Two separate stores, one debounced push — cast target changes land
      // in connect's own state (status.targets), not playback's; without
      // this second subscription, switching devices from the phone would
      // only be reflected back once something else happened to also mutate
      // playback (see playback.ts's connect.$subscribe handler, which
      // *does* cascade indirectly, but relying on that would be fragile).
      const unsubFromPlayback = playback.$subscribe(schedulePush, { detached: true })
      const unsubFromConnect = connect.$subscribe(schedulePush, { detached: true })
      unsubscribePlayback = () => {
        unsubFromPlayback()
        unsubFromConnect()
      }
    },

    /** Polls the single active cast target's volume (if there is exactly
     * one) so the phone's main Now Playing slider can show/control it, the
     * same way PlayerBar.vue's own deviceVolume polling does — connect's
     * SSE status has no volume field to push this instead (see
     * DEVICE_VOLUME_POLL_INTERVAL_MS's comment). With zero or 2+ active
     * targets there's no single device this control should represent
     * (matches PlayerBar.vue's local slider going `disabled` in the 2+
     * case) — the phone's device picker sheet (devices.js) is where each
     * individual target's volume lives instead, fetched on demand rather
     * than continuously polled here. */
    startDeviceVolumePoll(): void {
      if (deviceVolumePollTimer) return
      const connect = useConnectStore()
      const poll = async (): Promise<void> => {
        const targets = connect.activeTargets
        if (targets.length !== 1) {
          if (deviceVolumeCache !== null) {
            deviceVolumeCache = null
            schedulePushSnapshot?.()
          }
          return
        }
        const volume = await connect.getDeviceVolume(targets[0]!.type, targets[0]!.name)
        if (volume !== deviceVolumeCache) {
          deviceVolumeCache = volume
          schedulePushSnapshot?.()
        }
      }
      void poll()
      deviceVolumePollTimer = setInterval(() => void poll(), DEVICE_VOLUME_POLL_INTERVAL_MS)
    },
  },
})
