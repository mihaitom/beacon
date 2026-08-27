import { reactive } from 'vue'
import { usePlaybackStore } from '@/stores/playback'
import { useConnectStore } from '@/stores/connect'
import { STEP_FRACTION } from '@/services/volumeWheel'
import type { ConnectDeviceRef, ConnectStatusTarget } from '@/services/connect/types'

/**
 * "The volume" as a player-level command means it — the one thing a mute
 * toggle or a volume key should act on, without its caller having to know
 * whether anything is being cast to.
 *
 * Shared by PlayerToolbar.vue and the keyboard shortcuts rather than each
 * carrying its own copy: the pre-mute volume in particular has to be one
 * value, or muting with the M key and un-muting with the toolbar button
 * restores whatever that button last remembered instead of what was
 * actually playing. The per-device sliders in the connect picker
 * (DeviceListItem.vue) deliberately stay out of this — those name a
 * specific device rather than asking for "the" volume.
 */

/** Local playback runs 0-1, a cast device 0-100 — the scale follows from
 * which of the two a command lands on, so every value here travels with the
 * scope it belongs to rather than being normalized to one of them. */
export interface VolumeScope {
  /** The device a command should act on, or null for local playback. */
  device: ConnectStatusTarget | null
  max: number
}

/** Last reading seen for a device, keyed `type:name`. Reactive so
 * PlayerToolbar's slider follows a change made from the keyboard without
 * waiting for its own next poll.
 *
 * Kept fresh from three sides: PlayerToolbar's poll/first fetch reports
 * into it (see recordDeviceVolume), every set() below writes through it,
 * and for Sonos the pushed reading in the status wins over it outright
 * (see currentVolume). It can still go stale for chromecast/dlna while
 * nothing is polling — someone turning the speaker's own dial — which
 * costs one step landing off the device's real value; the reading that
 * follows corrects it. */
const knownDeviceVolumes = reactive(new Map<string, number>())

/** What to restore on un-mute, per scope. Local playback and each device
 * are muted independently and live on different scales, so they can't
 * share one field. */
const localVolumeBeforeMute = { value: 1 }
const deviceVolumesBeforeMute = new Map<string, number>()

function deviceKey(device: ConnectDeviceRef): string {
  return `${device.type}:${device.name}`
}

/**
 * Only ever a device when exactly one is being cast to *and* that device
 * type has a volume endpoint at all — with several active targets "the"
 * volume is ambiguous (that's what the picker's per-device sliders are
 * for), and AirPlay has no per-device volume to ask for (see
 * connectStore.isVolumeCapable()).
 */
export function volumeScope(): VolumeScope {
  const connect = useConnectStore()
  const targets = connect.activeTargets
  const single = targets.length === 1 ? targets[0] : null
  if (single && connect.isVolumeCapable(single.type)) return { device: single, max: 100 }
  return { device: null, max: 1 }
}

/** A reading PlayerToolbar already has (its own first fetch or 4s poll) —
 * handed over so a keyboard step doesn't have to make the same round trip
 * again right after. */
export function recordDeviceVolume(device: ConnectDeviceRef, volume: number): void {
  knownDeviceVolumes.set(deviceKey(device), volume)
}

/** Reactive — read it from a computed to follow keyboard-driven changes. */
export function knownDeviceVolume(device: ConnectDeviceRef): number | null {
  return knownDeviceVolumes.get(deviceKey(device)) ?? null
}

/**
 * Where the scope's volume currently sits, fetching once if this is the
 * first time anything has asked about a device. Null means the device
 * answered with no reading at all (a DLNA renderer without volume support)
 * — callers should leave the volume alone rather than guessing a value.
 */
export async function currentVolume(scope: VolumeScope): Promise<number | null> {
  if (!scope.device) return usePlaybackStore().volume
  const connect = useConnectStore()
  // The pushed reading first: for Sonos it's the live one (a
  // RenderingControl subscription, see connectStore.isVolumePushCapable()),
  // so it beats anything cached from an older round trip.
  const pushed = connect.pushedVolumeFor(scope.device.type, scope.device.name)
  if (pushed != null) return pushed
  const known = knownDeviceVolume(scope.device)
  if (known != null) return known
  const fetched = await connect.getDeviceVolume(scope.device.type, scope.device.name)
  if (fetched == null) return null
  const rounded = Math.round(fetched)
  recordDeviceVolume(scope.device, rounded)
  return rounded
}

export async function setVolume(scope: VolumeScope, volume: number): Promise<void> {
  const clamped = Math.min(scope.max, Math.max(0, volume))
  if (!scope.device) {
    usePlaybackStore().setVolume(clamped)
    return
  }
  const rounded = Math.round(clamped)
  recordDeviceVolume(scope.device, rounded)
  await useConnectStore().setDeviceVolume(scope.device.type, scope.device.name, rounded)
}

/**
 * One keyboard step, up (+1) or down (-1) — the same 5% of the scale one
 * mouse-wheel notch moves (see volumeWheel.ts), and snapped to that same
 * grid so a slider sitting at 42% goes to 45%/40% rather than 47%/37%.
 */
export async function nudgeVolume(direction: 1 | -1): Promise<void> {
  const scope = volumeScope()
  const current = await currentVolume(scope)
  // Same gate the mute toggle applies: while casting to something with no
  // volume of its own (AirPlay), local volume is not what anyone is
  // hearing, and moving it would silently change what this device plays at
  // once casting ends.
  if (current == null || !volumeControllable(scope, current)) return
  const step = scope.max * STEP_FRACTION
  // The epsilon absorbs float error the same way volumeAfterWheel() does —
  // 0.6 / 0.05 comes out as 11.999999999999998, which would otherwise cost
  // a whole step going up.
  const grid = current / step
  const from = direction > 0 ? Math.floor(grid + 1e-6) : Math.ceil(grid - 1e-6)
  await setVolume(scope, Number(((from + direction) * step).toFixed(4)))
}

/** Muted means 0 here, not a separate mute flag — same as every volume
 * surface in the app (see PlayerToolbar's volumeIcon). */
export function isMuted(volume: number | null): boolean {
  return volume === 0
}

/** Nothing to act on: local playback while casting (its slider is disabled
 * — the audio isn't coming from here), or a device that answered with no
 * reading. */
export function volumeControllable(scope: VolumeScope, volume: number | null): boolean {
  if (scope.device) return volume != null
  return !usePlaybackStore().isCasting
}

export async function toggleMute(): Promise<void> {
  const scope = volumeScope()
  const current = await currentVolume(scope)
  if (!volumeControllable(scope, current)) return
  if (scope.device) {
    const key = deviceKey(scope.device)
    if (isMuted(current)) {
      // The fallbacks (50 of 100, full local volume) only ever apply to a
      // device that was already sitting at 0 when this first saw it —
      // restoring to 0 would leave the un-mute doing visibly nothing.
      await setVolume(scope, deviceVolumesBeforeMute.get(key) || 50)
      return
    }
    deviceVolumesBeforeMute.set(key, current ?? 50)
    await setVolume(scope, 0)
    return
  }
  if (isMuted(current)) {
    await setVolume(scope, localVolumeBeforeMute.value || 1)
    return
  }
  localVolumeBeforeMute.value = current ?? 1
  await setVolume(scope, 0)
}
