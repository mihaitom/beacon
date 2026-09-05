import { defineStore } from 'pinia'
import {
  enableRemoteControl,
  disableRemoteControl,
  getRemoteControlStatus,
  sendRemoteKeepalive,
  pushRemoteState,
  respondToRemoteQuery,
  respondToRemoteCommand,
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
import { isBackingOff } from '@/services/connect/pollGate'
import { useAuthStore } from './auth'
import { useAutoplayStore } from './autoplay'

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
// Matches DeviceListItem.vue's own polling interval — the fallback for
// device types connectStore.isVolumePushCapable() doesn't cover (see
// startDeviceVolumePoll()'s own comment for the push-capable case).
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

// All of the above (timers, the agent SSE connection, deviceVolumeCache,
// ...) lives outside Pinia's reactive state — see playback.ts's identical
// accept()+invalidate() for the full story on why that's unsafe under
// Vite's partial HMR.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot!.invalidate(
      'stores/remoteControl.ts holds singleton state that cannot be safely hot-reloaded',
    )
  })
}

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
        // POST /remote/command (routes/remote.py) now blocks the phone's
        // request on this ack instead of returning as soon as it's
        // broadcast — see that endpoint's own comment. handleRemoteCommand
        // itself already swallows the failures worth swallowing (a
        // not-found song, a failed device switch, ...), so `error` here
        // only ever fires for something it didn't anticipate.
        void handleRemoteCommand(message.type, message.payload)
          .then(() => respondToRemoteCommand(message.request_id, { success: true }))
          .catch((error) => {
            console.error('[remoteControl] Failed to handle command:', error)
            return respondToRemoteCommand(message.request_id, { error: String(error) })
          })
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
      const autoplay = useAutoplayStore()
      const push = (): void => {
        statePushTimer = null
        const snapshot = {
          playing: playback.isPlaying,
          position: playback.localPosition,
          duration: playback.duration,
          volume: playback.volume,
          shuffle: playback.shuffle,
          repeat: playback.repeatMode,
          autoplay: autoplay.enabled,
          // Same capability gate PlayerBar.vue's own Autoplay button uses
          // (authStore.capabilities.songRadio) — now-playing.js hides its
          // button entirely rather than showing an always-inert one when
          // this is false.
          song_radio_supported: useAuthStore().capabilities.songRadio,
          current_song: playback.currentSong ? toRemoteSong(playback.currentSong) : null,
          radio: playback.radioStation
            ? {
                name: playback.radioStation.name,
                stream_url: playback.radioStation.streamUrl,
                favicon_url: remoteRadioFaviconUrl(
                  playback.radioStation.homePageUrl,
                  120,
                  playback.radioStation.favicon ?? null,
                ),
                // The station's ICY "now playing" tag and whether it is
                // currently stalled — the two things the phone's own
                // now-playing view needs to show a station the way this
                // app does (see RadioLiveStatus.vue and SongInfo.vue).
                // Both null/false rather than absent for a station that
                // reports neither, so the phone never has to tell "no tag"
                // apart from "an older desktop that never sent one".
                now_playing: playback.radioNowPlaying,
                buffering: playback.radioBuffering,
              }
            : null,
          queue: playback.queue.map(toRemoteSong),
          queue_index: playback.currentIndex,
          casting: connect.activeTargets,
          // A cast device dropped out on its own and playback can be picked
          // back up. State rather than an event, because this channel only
          // ever pushes snapshots — the phone renders a banner for as long
          // as it stands, the same condition the desktop toast reports once.
          interrupted: playback.castInterrupted,
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
      // Three separate stores, one debounced push — cast target changes land
      // in connect's own state (status.targets), not playback's, and
      // Autoplay's enabled flag lives in its own dedicated store (see
      // stores/autoplay.ts, toggled from PlayerBar.vue independently of
      // both); without these extra subscriptions, switching devices or
      // toggling Autoplay from the phone would only be reflected back once
      // something else happened to also mutate playback (see playback.ts's
      // connect.$subscribe handler, which *does* cascade indirectly for the
      // connect case, but relying on that would be fragile).
      const unsubFromPlayback = playback.$subscribe(schedulePush, { detached: true })
      const unsubFromConnect = connect.$subscribe(schedulePush, { detached: true })
      const unsubFromAutoplay = autoplay.$subscribe(schedulePush, { detached: true })
      unsubscribePlayback = () => {
        unsubFromPlayback()
        unsubFromConnect()
        unsubFromAutoplay()
      }
    },

    /** Polls the single active cast target's volume (if there is exactly
     * one) so the phone's main Now Playing slider can show/control it, the
     * same way PlayerBar.vue's own deviceVolume polling does. For a
     * push-capable type (see connectStore.isVolumePushCapable()) this
     * still ticks on the same interval - it doubles as "notice the target
     * changed", which the push channel alone doesn't tell this loop about
     * - but once a pushed reading actually exists it's used straight from
     * the store instead of a network round trip. Falls back to a real
     * fetch until the first one arrives (push only ever fires on the
     * *next* change, never proactively on claim - same gap
     * DeviceListItem.vue's own fetchVolume() covers with its one
     * always-on-activation call), so the very first tick for a
     * newly-active push-capable device still costs one request, not zero.
     * With zero or 2+ active targets there's no single device this
     * control should represent (matches PlayerBar.vue's local slider
     * going `disabled` in the 2+ case) - the phone's device picker sheet
     * (devices.js) is where each individual target's volume lives
     * instead, fetched on demand rather than continuously polled here. */
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
        const target = targets[0]!
        const pushed = connect.isVolumePushCapable(target.type, target.name)
          ? connect.pushedVolumeFor(target.type, target.name)
          : null
        const volume = pushed ?? (await connect.getDeviceVolume(target.type, target.name))
        if (volume !== deviceVolumeCache) {
          deviceVolumeCache = volume
          schedulePushSnapshot?.()
        }
      }
      void poll()
      deviceVolumePollTimer = setInterval(() => {
        // isBackingOff() rather than pollGate.ts's full pollingAllowed():
        // the consumer of this reading is the *phone*, so a hidden desktop
        // window is no reason to stop producing it. Being denied by
        // whatever sits in front of the backend is — the reading cannot
        // arrive anyway, and asking keeps the denial alive.
        if (!isBackingOff()) void poll()
      }, DEVICE_VOLUME_POLL_INTERVAL_MS)
    },

    /** Called right after commands.ts successfully applies a phone-initiated
     * device volume change — updates the cache immediately instead of
     * leaving it to startDeviceVolumePoll()'s next tick (up to
     * DEVICE_VOLUME_POLL_INTERVAL_MS away). Without this, the phone's own
     * slider (which stops overriding local drag state the instant it sends
     * the command, see now-playing.js) would get the next pushed snapshot
     * with the *old* cached value and visibly snap back before the poll
     * eventually caught up — the "jitter" this exists to avoid. */
    reportDeviceVolume(volume: number): void {
      deviceVolumeCache = volume
      schedulePushSnapshot?.()
    },
  },
})
