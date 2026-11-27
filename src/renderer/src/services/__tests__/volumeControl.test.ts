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

/** volume_push mirrors the backend's own per-device flag (see
 * connect/core/device_volume.py): a Sonos reports its own level, which is
 * what makes the pushed reading below the current one. */
function castTo(type: 'sonos' | 'airplay', name: string, volume?: number | null): void {
  useConnectStore().status = {
    targets: [
      {
        type,
        name,
        volume_push: type === 'sonos',
        ...(volume === undefined ? {} : { volume }),
      },
    ],
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

    expect(volumeScope()).toEqual({ device: null, group: null, max: 1 })
  })

  it('means the device while casting to exactly one that has a volume', async () => {
    const { volumeScope } = await freshModule()
    castTo('sonos', 'Kitchen')

    expect(volumeScope().device?.name).toBe('Kitchen')
    // A cast device's scale, not local playback's 0-1.
    expect(volumeScope().max).toBe(100)
  })

  it('means the master over all of them while several devices are active', async () => {
    const { volumeScope } = await freshModule()
    useConnectStore().status = {
      targets: [
        { type: 'sonos', name: 'Kitchen' },
        { type: 'sonos', name: 'Study' },
      ],
    } as ConnectStatus

    expect(volumeScope().device).toBeNull()
    expect(volumeScope().group?.map((t) => t.name)).toEqual(['Kitchen', 'Study'])
    expect(volumeScope().max).toBe(100)
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
    // A device with no reading yet: casting (so local volume controls
    // nothing), but no device volume to act on either.
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

  describe('master volume over several devices', () => {
    function castToRooms(kitchen: number | null, study: number | null): void {
      useConnectStore().status = {
        targets: [
          { type: 'sonos', name: 'Kitchen', volume_push: true, volume: kitchen },
          { type: 'sonos', name: 'Study', volume_push: true, volume: study },
        ],
      } as ConnectStatus
    }

    async function setup(mode: 'equal' | 'relative') {
      const module = await freshModule()
      const { useGroupVolumeStore } = await import('@/stores/groupVolume')
      useGroupVolumeStore().setMode(mode)
      vi.spyOn(useConnectStore(), 'setDeviceVolume').mockResolvedValue()
      const levels = () => ({
        kitchen: module.knownDeviceVolume({ type: 'sonos', name: 'Kitchen' }),
        study: module.knownDeviceVolume({ type: 'sonos', name: 'Study' }),
      })
      return { ...module, levels }
    }

    it('shows the loudest speaker', async () => {
      const { currentVolume, volumeScope } = await setup('equal')
      castToRooms(20, 40)

      expect(await currentVolume(volumeScope())).toBe(40)
    })

    it('puts every speaker on the same level in equal mode', async () => {
      const { setVolume, volumeScope, levels } = await setup('equal')
      castToRooms(20, 40)

      await setVolume(volumeScope(), 37)

      expect(levels()).toEqual({ kitchen: 37, study: 37 })
      expect(useConnectStore().setDeviceVolume).toHaveBeenCalledWith('sonos', 'Kitchen', 37)
      expect(useConnectStore().setDeviceVolume).toHaveBeenCalledWith('sonos', 'Study', 37)
    })

    it('keeps the balance in relative mode, back from 0 too', async () => {
      const { setVolume, volumeScope, levels } = await setup('relative')
      castToRooms(20, 40)

      await setVolume(volumeScope(), 20)
      expect(levels()).toEqual({ kitchen: 10, study: 20 })

      await setVolume(volumeScope(), 0)
      expect(levels()).toEqual({ kitchen: 0, study: 0 })

      await setVolume(volumeScope(), 40)
      expect(levels()).toEqual({ kitchen: 20, study: 40 })
    })

    it('starts from the new levels once a speaker was set on its own', async () => {
      const { setVolume, volumeScope, levels, recordDeviceVolume } = await setup('relative')
      castToRooms(20, 40)

      await setVolume(volumeScope(), 20)
      // Its own slider, in the picker.
      recordDeviceVolume({ type: 'sonos', name: 'Kitchen' }, 20)
      await setVolume(volumeScope(), 40)

      expect(levels()).toEqual({ kitchen: 40, study: 40 })
    })

    it('mutes and restores the whole group, balance included', async () => {
      const { toggleMute, levels } = await setup('relative')
      castToRooms(20, 40)

      await toggleMute()
      expect(levels()).toEqual({ kitchen: 0, study: 0 })

      await toggleMute()
      expect(levels()).toEqual({ kitchen: 20, study: 40 })
    })

    it('leaves a speaker without a reading alone', async () => {
      const { setVolume, volumeScope } = await setup('equal')
      vi.spyOn(useConnectStore(), 'getDeviceVolume').mockResolvedValue(null)
      castToRooms(30, null)

      await setVolume(volumeScope(), 50)

      expect(useConnectStore().setDeviceVolume).toHaveBeenCalledTimes(1)
      expect(useConnectStore().setDeviceVolume).toHaveBeenCalledWith('sonos', 'Kitchen', 50)
    })
  })
})
