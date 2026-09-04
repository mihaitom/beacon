import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VOLUME_SETTLE_MS,
  _resetVolumeGuards,
  acceptsVolumeReading,
  endVolumeDrag,
  noteVolumeChange,
  startVolumeDrag,
} from '../volumeGuard'

const kitchen = { type: 'sonos' as const, name: 'Kitchen' }
const bedroom = { type: 'chromecast' as const, name: 'Bedroom' }

describe('volumeGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetVolumeGuards()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('believes a device that nobody is arguing with', () => {
    expect(acceptsVolumeReading(kitchen)).toBe(true)
  })

  it('ignores readings for the whole length of a drag, however long it lasts', () => {
    startVolumeDrag(kitchen)

    vi.advanceTimersByTime(VOLUME_SETTLE_MS * 10)

    expect(acceptsVolumeReading(kitchen)).toBe(false)
  })

  it('keeps ignoring them for a moment after the drag, while the device catches up', () => {
    startVolumeDrag(kitchen)
    endVolumeDrag(kitchen)

    expect(acceptsVolumeReading(kitchen)).toBe(false)
    vi.advanceTimersByTime(VOLUME_SETTLE_MS - 1)
    expect(acceptsVolumeReading(kitchen)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(acceptsVolumeReading(kitchen)).toBe(true)
  })

  it('starts the window over on every further change, so a slow drag is never interrupted', () => {
    noteVolumeChange(kitchen)
    vi.advanceTimersByTime(VOLUME_SETTLE_MS - 100)
    noteVolumeChange(kitchen)

    vi.advanceTimersByTime(200)
    expect(acceptsVolumeReading(kitchen)).toBe(false)
  })

  it('holds one device without holding another', () => {
    // Two speakers are two independent volumes: setting one must not blind
    // the app to what the other reports.
    startVolumeDrag(kitchen)

    expect(acceptsVolumeReading(kitchen)).toBe(false)
    expect(acceptsVolumeReading(bedroom)).toBe(true)
  })
})
