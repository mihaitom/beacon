import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlaybackStore } from '@/stores/playback'
import { useConnectStore } from '@/stores/connect'
import { getAudioEngine } from '@/services/audioEngine'
import type { ConnectStatus } from '@/services/connect/types'

vi.mock('@/services/audioEngine', () => ({
  getAudioEngine: vi.fn(),
}))

/** The module keeps its own state (the per-device readings, the pre-mute
 * volumes) deliberately — that's what makes the keyboard and the toolbar
 * agree. Re-importing per test is how each one starts from nothing rather
 * than inheriting the previous test's mute memory. */
async function freshModule(): Promise<typeof import('../volumeControl')> {
  vi.resetModules()
  return import('../volumeControl')
}

function castTo(type: 'sonos' | 'airplay', name: string, volume?: number | null): void {
  useConnectStore().status = {
    targets: [{ type, name, ...(volume === undefined ? {} : { volume }) }],
  } as ConnectStatus
}

describe('volumeControl', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getAudioEngine).mockReturnValue({
      setVolume: vi.fn(),
    } as unknown as ReturnType<typeof getAudioEngine>)
  })

  it('means local playback while nothing is being cast to', async () => {
    const { volumeScope } = await freshModule()

    expect(volumeScope()).toEqual({ device: null, max: 1 })
  })

  it('means the device while casting to exactly one that has a volume', async () => {
    const { volumeScope } = await freshModule()
    castTo('sonos', 'Kitchen')

    expect(volumeScope().device?.name).toBe('Kitchen')
    // A cast device's scale, not local playback's 0-1.
    expect(volumeScope().max).toBe(100)
  })

  it('falls back to local for a device with no volume of its own', async () => {
    // AirPlay has no per-device volume endpoint — asking for one can only
    // ever come back empty, so "the volume" can't mean it.
    const { volumeScope } = await freshModule()
    castTo('airplay', 'HomePod')

    expect(volumeScope().device).toBeNull()
  })

  it('stays out of it while several devices are active', async () => {
    // With two targets "the" volume is ambiguous — that's what the
    // per-device sliders in the picker are for.
    const { volumeScope } = await freshModule()
    useConnectStore().status = {
      targets: [
        { type: 'sonos', name: 'Kitchen' },
        { type: 'sonos', name: 'Study' },
      ],
    } as ConnectStatus

    expect(volumeScope().device).toBeNull()
  })

  it('steps local volume by 5%, snapped to the same grid the wheel uses', async () => {
    const { nudgeVolume } = await freshModule()
    const playback = usePlaybackStore()
    playback.volume = 0.42

    await nudgeVolume(1)
    expect(playback.volume).toBeCloseTo(0.45)

    await nudgeVolume(-1)
    expect(playback.volume).toBeCloseTo(0.4)
  })

  it('does not run past either end of the scale', async () => {
    const { nudgeVolume } = await freshModule()
    const playback = usePlaybackStore()
    playback.volume = 1

    await nudgeVolume(1)
    expect(playback.volume).toBe(1)

    playback.volume = 0
    await nudgeVolume(-1)
    expect(playback.volume).toBe(0)
  })

  it('steps the device instead while casting, reading its pushed volume', async () => {
    const { nudgeVolume } = await freshModule()
    const connect = useConnectStore()
    const setDeviceVolume = vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
    const getDeviceVolume = vi.spyOn(connect, 'getDeviceVolume')
    castTo('sonos', 'Kitchen', 40)

    await nudgeVolume(1)

    expect(setDeviceVolume).toHaveBeenCalledWith('sonos', 'Kitchen', 45)
    // The pushed reading is the live one — no round trip needed to find out
    // where the device currently sits.
    expect(getDeviceVolume).not.toHaveBeenCalled()
  })

  it('asks the device once for a type that pushes nothing, then works from that', async () => {
    const { nudgeVolume } = await freshModule()
    const connect = useConnectStore()
    vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
    const getDeviceVolume = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(50)
    castTo('sonos', 'Kitchen', null) // claimed, but no reading pushed yet

    await nudgeVolume(1)
    await nudgeVolume(1)

    // Holding the key down must not turn into one HTTP request per step.
    expect(getDeviceVolume).toHaveBeenCalledTimes(1)
  })

  it('restores what was actually playing when un-muting, whoever muted', async () => {
    const { toggleMute } = await freshModule()
    const playback = usePlaybackStore()
    playback.volume = 0.3

    await toggleMute()
    expect(playback.volume).toBe(0)

    await toggleMute()
    expect(playback.volume).toBe(0.3)
  })

  it('un-mutes to something audible even if it never saw a pre-mute volume', async () => {
    // Muting a device that was already sitting at 0 the first time this saw
    // it — restoring to 0 would leave the un-mute doing visibly nothing.
    const { toggleMute } = await freshModule()
    const connect = useConnectStore()
    const setDeviceVolume = vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
    castTo('sonos', 'Kitchen', 0)

    await toggleMute()

    expect(setDeviceVolume).toHaveBeenCalledWith('sonos', 'Kitchen', 50)
  })

  it('leaves local volume alone while casting — that slider is not what is playing', async () => {
    const { nudgeVolume, toggleMute } = await freshModule()
    const playback = usePlaybackStore()
    playback.volume = 0.8
    // An AirPlay target: casting (so local volume controls nothing), but no
    // device volume to act on either.
    castTo('airplay', 'HomePod')

    await toggleMute()
    await nudgeVolume(1)

    expect(playback.volume).toBe(0.8)
  })

  it('hands a reading over to the toolbar and back', async () => {
    const { knownDeviceVolume, recordDeviceVolume } = await freshModule()
    const device = { type: 'sonos', name: 'Kitchen' } as const

    expect(knownDeviceVolume(device)).toBeNull()
    recordDeviceVolume(device, 35)

    expect(knownDeviceVolume(device)).toBe(35)
  })
})
