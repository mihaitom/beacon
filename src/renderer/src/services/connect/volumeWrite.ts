import type { ConnectDeviceRef } from '@/services/connect/types'

/**
 * Sends a device's volume without flooding it, and without letting an older
 * value land last.
 *
 * A slider reports every move, which on a phone is one event per frame: a
 * single finger drag across the bar produced 25 commands in a real-browser
 * measurement, one per touchmove. Each is a separate request, and
 * connect/routes/volume.py runs them unserialised - a thread per request
 * doing a blocking call to the speaker. Two dozen of those complete in
 * whatever order the network and the device decide, so the level the
 * speaker ends up at is whichever command happened to land last, not the
 * one the finger stopped on. Released near the top and the speaker sitting
 * at the level the drag *started* from is the visible form of that, and the
 * slider then snaps there as soon as the device is believed again (see
 * volumeGuard.ts).
 *
 * So: one request per device in flight at a time. Moves that happen while
 * one is out do not queue up behind it - they replace each other, because
 * only the newest is still true. When the request comes back, the newest
 * value left over is sent, and so on until the finger stops and the last
 * thing sent is the value it stopped on.
 *
 * That also paces the writes to whatever the device can actually keep up
 * with, rather than to a guessed interval: a speaker that answers in 20ms
 * gets a smooth ramp, one that answers in 300ms gets four commands for the
 * same drag.
 *
 * Every way a device's level can be set goes through here - the player
 * bar's slider, the phone's (PlayerToolbar.vue,
 * MobileTransportControls.vue), both device lists' per-device sliders
 * (ConnectDevicePicker.vue via DeviceListItem.vue, MobileDeviceRow.vue)
 * and the keyboard/wheel steps in volumeControl.ts. The LAN remote does
 * not: its sliders fire on 'change' rather than 'input', so a drag there
 * was always one command (see static/remote/js/views/now-playing.js).
 */

interface WriteState {
  /** Newest value not yet sent, null when everything is sent. */
  pending: number | null
  sending: boolean
  send: ((volume: number) => Promise<unknown>) | null
}

const writes = new Map<string, WriteState>()

function stateOf(device: ConnectDeviceRef): WriteState {
  const key = `${device.type}:${device.name}`
  let state = writes.get(key)
  if (!state) {
    state = { pending: null, sending: false, send: null }
    writes.set(key, state)
  }
  return state
}

async function drain(state: WriteState): Promise<void> {
  state.sending = true
  try {
    while (state.pending != null && state.send) {
      const volume = state.pending
      state.pending = null
      try {
        await state.send(volume)
      } catch (error) {
        // Swallowed until now, which is what made a refused change look
        // like a broken slider: the level bounced back with nothing said.
        console.error('[volume-write] Device refused the new level:', error)
      }
    }
  } finally {
    state.sending = false
  }
}

/** Set `device` to `volume`, sending it as soon as that device is free. */
export function writeDeviceVolume(
  device: ConnectDeviceRef,
  volume: number,
  send: (volume: number) => Promise<unknown>,
): void {
  const state = stateOf(device)
  state.pending = volume
  state.send = send
  if (!state.sending) void drain(state)
}

/** Test seam - the map outlives any one component, and a value left pending
 * from one test would be sent during the next. */
export function _resetVolumeWrites(): void {
  writes.clear()
}
