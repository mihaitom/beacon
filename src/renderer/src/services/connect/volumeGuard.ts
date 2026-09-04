import type { ConnectDeviceRef } from '@/services/connect/types'

/**
 * Keeps a device's own volume readings from fighting the person setting it.
 *
 * Every place that shows a cast device's volume (PlayerToolbar.vue,
 * DeviceListItem.vue, MobileDeviceRow.vue) holds one number written from
 * two directions: the user, and the device itself — a 4s poll for
 * Chromecast/DLNA, a pushed reading for Sonos. The two disagree for as long
 * as it takes a change to reach the speaker and be reported back, so a
 * reading already in flight (or one that predates the drag entirely) lands
 * on top of what the user is doing and the slider jumps back to where it
 * was. Reported live 2026-09-04 as the volume slider bouncing back every so
 * often.
 *
 * A reading is therefore only believed while the user is not, and has not
 * just been, setting that device's volume themselves: what they did wins
 * until the device has had time to agree with it.
 *
 * Keyed by device and shared across the app rather than kept per component,
 * because the change and the reading it has to beat rarely happen in the
 * same place: the volume keys go through services/volumeControl.ts, the
 * poll lives in whichever slider happens to be mounted, and the picker's
 * per-device slider and the player bar's show the same device at once.
 */

/** How long after a change the device's own readings stay ignored.
 *
 * Long enough to cover the round trip *and* the speaker's own lag in
 * reporting a new value (Sonos in particular answers with the old one for a
 * moment after accepting a change), short enough that turning the dial on
 * the speaker itself still shows up here within a couple of seconds. */
export const VOLUME_SETTLE_MS = 2500

interface GuardState {
  dragging: boolean
  ignoreUntil: number
}

const guards = new Map<string, GuardState>()

function keyOf(device: ConnectDeviceRef): string {
  return `${device.type}:${device.name}`
}

function stateOf(device: ConnectDeviceRef): GuardState {
  const key = keyOf(device)
  let state = guards.get(key)
  if (!state) {
    state = { dragging: false, ignoreUntil: 0 }
    guards.set(key, state)
  }
  return state
}

/** The slider took the pointer — no reading is believed until it lets go,
 * however long the drag lasts. */
export function startVolumeDrag(device: ConnectDeviceRef): void {
  stateOf(device).dragging = true
}

/** The drag ended; the settle window starts from here. */
export function endVolumeDrag(device: ConnectDeviceRef): void {
  const state = stateOf(device)
  state.dragging = false
  state.ignoreUntil = performance.now() + VOLUME_SETTLE_MS
}

/** A value was sent to this device — a drag tick, a wheel step, a keyboard
 * step, a mute toggle. Restarts the settle window. */
export function noteVolumeChange(device: ConnectDeviceRef): void {
  stateOf(device).ignoreUntil = performance.now() + VOLUME_SETTLE_MS
}

/** Whether a reading from this device may be applied right now. */
export function acceptsVolumeReading(device: ConnectDeviceRef): boolean {
  const state = stateOf(device)
  return !state.dragging && performance.now() >= state.ignoreUntil
}

/** Test seam — the map outlives any one component, and a settle window left
 * over from one test would silently swallow the next one's readings. */
export function _resetVolumeGuards(): void {
  guards.clear()
}
