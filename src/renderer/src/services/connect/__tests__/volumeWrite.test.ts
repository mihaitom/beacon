import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetVolumeWrites, writeDeviceVolume } from '../volumeWrite'
import {
  VOLUME_SETTLE_MS,
  _resetVolumeGuards,
  acceptsVolumeReading,
  noteVolumeChange,
} from '../volumeGuard'
import type { ConnectDeviceRef } from '../types'

const kitchen: ConnectDeviceRef = { type: 'sonos', name: 'Kitchen' }
const study: ConnectDeviceRef = { type: 'chromecast', name: 'Study' }

/** A send whose answers are released by hand, so "while one is in flight"
 * is a state the test controls rather than races against. */
function deferredSend() {
  const sent: number[] = []
  const pending: Array<() => void> = []
  const send = vi.fn((volume: number) => {
    sent.push(volume)
    return new Promise<void>((resolve) => pending.push(resolve))
  })
  return {
    sent,
    send,
    /** Let the oldest outstanding request answer. */
    async answer() {
      pending.shift()?.()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('writeDeviceVolume', () => {
  beforeEach(() => {
    _resetVolumeWrites()
    _resetVolumeGuards()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the first value straight away', async () => {
    const { send, sent, answer } = deferredSend()

    writeDeviceVolume(kitchen, 40, send)
    await answer()

    expect(sent).toEqual([40])
  })

  // The actual defect: a drag reports every frame, and sending each one
  // left the speaker at whichever request happened to land last.
  it('keeps one request in flight and collapses everything a drag reports meanwhile', async () => {
    const { send, sent, answer } = deferredSend()

    writeDeviceVolume(kitchen, 31, send)
    for (const volume of [45, 58, 66, 79, 85]) writeDeviceVolume(kitchen, volume, send)
    expect(sent).toEqual([31])

    await answer()
    // Only the newest of the five, not all of them in order.
    expect(sent).toEqual([31, 85])

    await answer()
    expect(sent).toEqual([31, 85])
  })

  it('ends on the value the finger stopped at', async () => {
    const { send, sent, answer } = deferredSend()

    writeDeviceVolume(kitchen, 30, send)
    writeDeviceVolume(kitchen, 70, send)
    writeDeviceVolume(kitchen, 55, send)
    await answer()
    await answer()

    expect(sent.at(-1)).toBe(55)
  })

  it('holds each device on its own, so one slow speaker does not block another', async () => {
    const { send, sent, answer } = deferredSend()

    writeDeviceVolume(kitchen, 40, send)
    writeDeviceVolume(study, 20, send)

    expect(sent).toEqual([40, 20])
    await answer()
  })

  // The settle window that keeps a device's own readings off the slider
  // (see volumeGuard.ts) used to run from the moment the slider moved,
  // which is not the moment the speaker hears about it: a value queued
  // behind an in-flight request goes out later than the window lasts, and
  // the reading that lands next is then still the one from before the
  // change - the slider snapping back to roughly where the drag began.
  it('holds the settle window open until the device has answered', async () => {
    vi.useFakeTimers()
    const { send, answer } = deferredSend()

    // What a slider does on every move: open the window, queue the value.
    noteVolumeChange(kitchen)
    writeDeviceVolume(kitchen, 40, send)
    writeDeviceVolume(kitchen, 85, send)

    // A speaker taking its time - a Sonos call carries the SSDP discovery
    // cost - and the window the move opened has run out meanwhile.
    vi.advanceTimersByTime(VOLUME_SETTLE_MS + 1)
    // Checked here, before the answer: this is the moment the reading
    // actually arrives in. Nothing has acknowledged 85 yet, so anything the
    // speaker reports is still the level the drag began at.
    expect(acceptsVolumeReading(kitchen)).toBe(false)

    await answer()
    expect(acceptsVolumeReading(kitchen)).toBe(false)

    await answer()
    vi.advanceTimersByTime(VOLUME_SETTLE_MS - 1)
    expect(acceptsVolumeReading(kitchen)).toBe(false)
    // And it does expire: a hand on the speaker's own dial still shows up.
    vi.advanceTimersByTime(1)
    expect(acceptsVolumeReading(kitchen)).toBe(true)
  })

  // The same gap one layer in: the queue is briefly empty between an answer
  // coming back and the next value being queued behind it, and the device
  // is no more at the final level then than it was a moment earlier.
  it('keeps readings out across the whole queue, not just one request', async () => {
    vi.useFakeTimers()
    const { send, answer } = deferredSend()

    writeDeviceVolume(kitchen, 40, send)
    writeDeviceVolume(kitchen, 85, send)
    await answer()

    // 85 is on its way but unanswered; the window from 40 has long gone.
    vi.advanceTimersByTime(VOLUME_SETTLE_MS + 1)
    expect(acceptsVolumeReading(kitchen)).toBe(false)
  })

  it('reports a refused change instead of swallowing it, and carries on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('device_in_use'))
      .mockResolvedValue(undefined)

    writeDeviceVolume(kitchen, 40, send)
    await Promise.resolve()
    await Promise.resolve()
    expect(error).toHaveBeenCalled()

    writeDeviceVolume(kitchen, 60, send)
    await Promise.resolve()
    await Promise.resolve()
    expect(send).toHaveBeenLastCalledWith(60)
  })
})
