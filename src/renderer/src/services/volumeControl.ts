import { reactive } from 'vue'
import { usePlaybackStore } from '@/stores/playback'
import { useConnectStore } from '@/stores/connect'
import { STEP_FRACTION } from '@/services/volumeWheel'
import { acceptsVolumeReading, noteVolumeChange } from '@/services/connect/volumeGuard'
import { writeDeviceVolume } from '@/services/connect/volumeWrite'
import { groupLevel, planGroupVolume, type GroupAnchor } from '@/services/groupVolume'
import { useGroupVolumeStore } from '@/stores/groupVolume'
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
 * actually playing. The per-device sliders in the cast menu
 * (ConnectDevicePicker.vue) deliberately stay out of this — those name a
 * specific device rather than asking for "the" volume.
 *
 * With several cast targets, "the" volume is the master over all of them
 * (see services/groupVolume.ts).
 */

/** Local playback runs 0-1, a cast device 0-100 — the scale follows from
 * which of the two a command lands on, so every value here travels with the
 * scope it belongs to rather than being normalized to one of them. */
export interface VolumeScope {
  /** The device a command should act on, or null for local playback. */
  device: ConnectStatusTarget | null
  /** Two or more cast targets: the ones with a volume of their own, moved
   * together by the master. Null otherwise. */
  group: ConnectStatusTarget[] | null
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
const GROUP_MUTE_KEY = 'group'

/** See GroupAnchor - one per app, since there is only ever one group. */
let groupAnchor: GroupAnchor | null = null

function deviceKey(device: ConnectDeviceRef): string {
  return `${device.type}:${device.name}`
}

/**
 * A device when exactly one is being cast to *and* that device type has a
 * volume endpoint at all (a type without one has nothing to ask for, see
 * connectStore.isVolumeCapable()); the master over all of them when there
 * are several; local playback otherwise.
 */
export function volumeScope(): VolumeScope {
  const connect = useConnectStore()
  const targets = connect.activeTargets
  if (targets.length > 1) {
    const group = targets.filter((target) => connect.isVolumeCapable(target.type))
    return { device: null, group, max: 100 }
  }
  const single = targets.length === 1 ? targets[0] : null
  if (single && connect.isVolumeCapable(single.type)) {
    return { device: single, group: null, max: 100 }
  }
  return { device: null, group: null, max: 1 }
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
  if (scope.group) {
    await fetchMissingGroupVolumes(scope.group)
    return groupLevel(groupVolumes(scope.group).values())
  }
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

/**
 * A group member's level as far as this app knows it, without asking the
 * device: its pushed reading while nobody is setting it (see
 * volumeGuard.ts), otherwise the last one seen or sent.
 */
function memberVolume(device: ConnectDeviceRef): number | null {
  const known = knownDeviceVolume(device)
  if (!acceptsVolumeReading(device)) return known
  return useConnectStore().pushedVolumeFor(device.type, device.name) ?? known
}

/** Keyed `type:name`; members without any reading are left out, so a
 * master move never invents a level for them. */
function groupVolumes(group: ConnectDeviceRef[]): Map<string, number> {
  const volumes = new Map<string, number>()
  for (const device of group) {
    const volume = memberVolume(device)
    if (volume != null) volumes.set(deviceKey(device), volume)
  }
  return volumes
}

async function fetchMissingGroupVolumes(group: ConnectDeviceRef[]): Promise<void> {
  const connect = useConnectStore()
  await Promise.all(
    group
      .filter((device) => memberVolume(device) == null)
      .map(async (device) => {
        const fetched = await connect.getDeviceVolume(device.type, device.name)
        if (fetched != null) recordDeviceVolume(device, Math.round(fetched))
      }),
  )
}

/** Sets one device and tells every slider showing it. */
export function sendDeviceVolume(device: ConnectDeviceRef, volume: number): void {
  recordDeviceVolume(device, volume)
  // Every slider showing this device now ignores its own readings for a
  // moment — see volumeGuard.ts. Without this, a keyboard step or a mute
  // toggle was overwritten a second later by a poll that had been in
  // flight, or by a push carrying the pre-change value.
  noteVolumeChange(device)
  // Serialised like every slider's own writes - see volumeWrite.ts. A held
  // arrow key repeats at the keyboard's own rate and a wheel spins faster
  // still, which is the same burst a drag produces.
  writeDeviceVolume(device, volume, (level) =>
    useConnectStore().setDeviceVolume(device.type, device.name, level),
  )
}

/**
 * The level a speaker joining `playing` should start at in 'equal' mode:
 * the average of the ones already playing, so it fits in without any of
 * them changing. Null in 'relative' mode (the speaker keeps its own level
 * - that difference is what the mode keeps) and when nothing playing has a
 * reading.
 */
export async function levelForJoiningSpeaker(playing: ConnectDeviceRef[]): Promise<number | null> {
  if (useGroupVolumeStore().mode !== 'equal') return null
  const connect = useConnectStore()
  const members = playing.filter((device) => connect.isVolumeCapable(device.type))
  if (!members.length) return null
  await fetchMissingGroupVolumes(members)
  const levels = [...groupVolumes(members).values()]
  if (!levels.length) return null
  return Math.round(levels.reduce((sum, level) => sum + level, 0) / levels.length)
}

async function setGroupVolume(group: ConnectDeviceRef[], level: number): Promise<void> {
  await fetchMissingGroupVolumes(group)
  // Read after the await, not before: a drag sends a value per frame, and
  // planning from levels read before the previous move was sent would
  // break the relative anchor on every frame.
  const { volumes, anchor } = planGroupVolume(
    groupVolumes(group),
    level,
    useGroupVolumeStore().mode,
    groupAnchor,
  )
  groupAnchor = anchor
  for (const device of group) {
    const volume = volumes.get(deviceKey(device))
    if (volume != null) sendDeviceVolume(device, volume)
  }
}

export async function setVolume(scope: VolumeScope, volume: number): Promise<void> {
  const clamped = Math.min(scope.max, Math.max(0, volume))
  if (scope.group) {
    await setGroupVolume(scope.group, clamped)
    return
  }
  if (!scope.device) {
    usePlaybackStore().setVolume(clamped)
    return
  }
  sendDeviceVolume(scope.device, Math.round(clamped))
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
  // volume reading, local volume is not what anyone is
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

/** Nothing to act on: local playback while casting to a device without a
 * volume of its own (the audio isn't coming from here), or devices that
 * answered with no reading. */
export function volumeControllable(scope: VolumeScope, volume: number | null): boolean {
  if (scope.device || scope.group) return volume != null
  return !usePlaybackStore().isCasting
}

export async function toggleMute(): Promise<void> {
  const scope = volumeScope()
  const current = await currentVolume(scope)
  if (!volumeControllable(scope, current)) return
  if (scope.device || scope.group) {
    const key = scope.device ? deviceKey(scope.device) : GROUP_MUTE_KEY
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

/** Test seam - the readings, the pre-mute levels and the master's anchor
 * outlive any one component, and one test's would leak into the next. */
export function _resetVolumeControl(): void {
  knownDeviceVolumes.clear()
  deviceVolumesBeforeMute.clear()
  localVolumeBeforeMute.value = 1
  groupAnchor = null
}
