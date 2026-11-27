import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import { VBtn } from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { useConnectStore } from '@/stores/connect'
import { useGroupVolumeStore } from '@/stores/groupVolume'
import { usePlaybackStore } from '@/stores/playback'
import { _resetVolumeWrites } from '@/services/connect/volumeWrite'
import { _resetVolumeGuards } from '@/services/connect/volumeGuard'
import { _resetVolumeControl } from '@/services/volumeControl'
import { _resetPollGate, noteResponseStatus } from '@/services/connect/pollGate'
import ConnectDevicePicker from '../ConnectDevicePicker.vue'
import VolumeFader from '../VolumeFader.vue'
import AvailableDeviceRow from '../AvailableDeviceRow.vue'
import type { ConnectStatusTarget, DiscoverResponse } from '@/services/connect/types'
import { makeStatus } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function mountPicker() {
  return mount(ConnectDevicePicker, {
    global: {
      plugins: [vuetify, i18n],
      stubs: { AirplayPairingDialog: true },
    },
  })
}

function makeDevices(overrides: Partial<DiscoverResponse> = {}): DiscoverResponse {
  return { sonos: [], airplay: [], chromecast: [], dlna: [], ...overrides }
}

function castTo(targets: Partial<ConnectStatusTarget>[]): void {
  useConnectStore().status = makeStatus({
    targets: targets.map((t) => ({ type: 'sonos', volume_push: true, ...t })),
  } as never)
}

function availableNames(wrapper: ReturnType<typeof mountPicker>): string[] {
  return wrapper
    .findAllComponents(AvailableDeviceRow)
    .map((row) => row.props('device').name as string)
}

function faders(wrapper: ReturnType<typeof mountPicker>) {
  return wrapper.findAllComponents(VolumeFader)
}

describe('ConnectDevicePicker', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    // Module state that outlives a test — a leftover backoff, a hidden
    // document, a settle window or a reading would leak into the next one.
    _resetPollGate()
    _resetVolumeGuards()
    _resetVolumeControl()
    _resetVolumeWrites()
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    _resetPollGate()
  })

  describe('speakers to add', () => {
    it('shows "no devices found" when the scan came back empty', () => {
      const wrapper = mountPicker()

      expect(wrapper.text()).toContain('No devices found')
      expect(wrapper.findAllComponents(AvailableDeviceRow)).toHaveLength(0)
    })

    it('says an empty list is still being scanned rather than empty', async () => {
      const connect = useConnectStore()
      const wrapper = mountPicker()

      connect.isScanning = true
      await wrapper.vm.$nextTick()

      expect(wrapper.text()).toContain('Looking for devices')
      expect(wrapper.text()).not.toContain('No devices found')
    })

    it('lists every speaker not yet playing, by type and then by name', () => {
      const connect = useConnectStore()
      connect.devices = makeDevices({
        dlna: [{ name: 'Living Room DLNA' }],
        airplay: [{ name: 'Zulu Speaker' }, { name: 'Alpha Speaker' }],
        sonos: [{ name: 'Kitchen' }, { name: 'Study' }],
      })
      castTo([{ name: 'Study' }])
      const wrapper = mountPicker()

      expect(availableNames(wrapper)).toEqual([
        'Kitchen',
        'Alpha Speaker',
        'Zulu Speaker',
        'Living Room DLNA',
      ])
    })

    it('says so when every speaker found is already playing', () => {
      const connect = useConnectStore()
      connect.devices = makeDevices({ sonos: [{ name: 'Kitchen' }] })
      castTo([{ name: 'Kitchen' }])
      const wrapper = mountPicker()

      expect(wrapper.text()).toContain('Every speaker found is playing')
    })

    it('adds a speaker to what is already playing with one click', async () => {
      const connect = useConnectStore()
      connect.devices = makeDevices({ sonos: [{ name: 'Kitchen' }, { name: 'Study' }] })
      castTo([{ name: 'Study' }])
      const apply = vi.spyOn(usePlaybackStore(), 'applyTargets').mockResolvedValue()
      const wrapper = mountPicker()

      await wrapper.get('.available__main').trigger('click')

      expect(apply).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'sonos', name: 'Study' }),
        { type: 'sonos', name: 'Kitchen' },
      ])
    })

    it('swallows a failed add instead of leaving an unhandled rejection', async () => {
      const connect = useConnectStore()
      connect.devices = makeDevices({ sonos: [{ name: 'Kitchen' }] })
      vi.spyOn(usePlaybackStore(), 'applyTargets').mockRejectedValue(new Error('nope'))
      const wrapper = mountPicker()

      await wrapper.get('.available__main').trigger('click')
      await flushPromises()

      // The row is usable again for another try.
      expect(wrapper.getComponent(AvailableDeviceRow).props('busy')).toBe(false)
    })

    it('takes over a speaker someone else is using, in addition to what plays', async () => {
      const connect = useConnectStore()
      useAuthStore().sessionId = 'mine'
      connect.devices = makeDevices({
        sonos: [{ name: 'Kitchen', in_use_by_session_id: 'theirs', in_use_by_name: 'Sam' }],
      })
      castTo([{ name: 'Study' }])
      const apply = vi.spyOn(usePlaybackStore(), 'applyTargets').mockResolvedValue()
      const wrapper = mountPicker()

      expect(wrapper.text()).toContain('In use by Sam')
      // Not by clicking the row - that is someone else's music.
      expect(wrapper.get('.available__main').attributes('disabled')).toBeDefined()

      await wrapper.getComponent(AvailableDeviceRow).vm.$emit('take-over')

      expect(apply).toHaveBeenCalledWith(
        [expect.objectContaining({ name: 'Study' }), { type: 'sonos', name: 'Kitchen' }],
        true,
      )
    })

    it('opens the AirPlay pairing dialog for the speaker that asked for it', async () => {
      const connect = useConnectStore()
      connect.devices = makeDevices({ airplay: [{ name: 'Office', needs_pairing: true }] })
      const wrapper = mountPicker()

      await wrapper.getComponent(AvailableDeviceRow).vm.$emit('pair')

      const dialog = wrapper.findComponent({ name: 'AirplayPairingDialog' })
      expect(dialog.props('modelValue')).toBe(true)
      expect(dialog.props('deviceName')).toBe('Office')
    })

    it('kicks off a fresh scan from the rescan button, and locks it while one runs', async () => {
      const connect = useConnectStore()
      const wrapper = mountPicker()
      const refreshSpy = vi.spyOn(connect, 'refreshDevices').mockResolvedValue()

      const rescan = wrapper.getComponent<typeof VBtn>('.connect-picker__rescan')
      await rescan.trigger('click')
      expect(refreshSpy).toHaveBeenCalledWith(true)

      // Disabled while scanning, so a second click can't start an
      // overlapping scan whose earlier-finishing sibling would clear
      // isScanning while the later one is still running.
      connect.isScanning = true
      await wrapper.vm.$nextTick()
      expect(rescan.props('disabled')).toBe(true)
    })
  })

  describe('speakers playing', () => {
    it('stops one speaker and keeps the others playing', async () => {
      castTo([{ name: 'Kitchen' }, { name: 'Study' }])
      const apply = vi.spyOn(usePlaybackStore(), 'applyTargets').mockResolvedValue()
      const wrapper = mountPicker()

      const kitchen = faders(wrapper).find((f) => f.props('label') === 'Kitchen')!
      await kitchen.vm.$emit('remove')

      expect(apply).toHaveBeenCalledWith([expect.objectContaining({ name: 'Study' })])
    })

    it('brings playback back here by stopping every cast target', async () => {
      castTo([{ name: 'Kitchen' }])
      const stopAll = vi.spyOn(useConnectStore(), 'stopAll').mockResolvedValue()
      const wrapper = mountPicker()

      await wrapper.get('.connect-picker__local').trigger('click')

      expect(stopAll).toHaveBeenCalled()
    })

    it('names this device as the one playing while nothing is cast', () => {
      const wrapper = mountPicker()

      expect(wrapper.find('.connect-picker__here').text()).toContain('This device')
      expect(wrapper.find('.connect-picker__local').exists()).toBe(false)
    })

    it('offers stop-all only while casting', async () => {
      const connect = useConnectStore()
      const stopAll = vi.spyOn(connect, 'stopAll').mockResolvedValue()
      const wrapper = mountPicker()
      expect(wrapper.text()).not.toContain('Stop all')

      castTo([{ name: 'Kitchen' }])
      await wrapper.vm.$nextTick()
      const button = wrapper.findAllComponents(VBtn).find((b) => b.text().includes('Stop all'))!
      await button.trigger('click')

      expect(stopAll).toHaveBeenCalled()
    })

    it('keeps the stream info section, casting or not', () => {
      castTo([{ name: 'Kitchen' }])
      const wrapper = mountPicker()

      expect(wrapper.findComponent({ name: 'StreamInfoSection' }).exists()).toBe(true)
    })
  })

  describe('volume', () => {
    it("sets a single speaker's volume from its row", async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      const setVolume = vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
      castTo([{ name: 'Kitchen', volume_push: false }])
      const wrapper = mountPicker()
      await flushPromises()

      const row = faders(wrapper)[0]!
      expect(row.props('modelValue')).toBe(30)

      row.vm.$emit('update:modelValue', 55)
      await flushPromises()

      expect(setVolume).toHaveBeenCalledWith('sonos', 'Kitchen', 55)
      expect(row.props('modelValue')).toBe(55)
    })

    it('collapses a drag into one request at a time, ending on the released level', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      let release: () => void = () => {}
      const setVolume = vi
        .spyOn(connect, 'setDeviceVolume')
        .mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
      castTo([{ name: 'Kitchen', volume_push: false }])
      const wrapper = mountPicker()
      await flushPromises()

      const row = faders(wrapper)[0]!
      for (const level of [40, 50, 60, 70]) row.vm.$emit('update:modelValue', level)
      expect(setVolume).toHaveBeenCalledTimes(1)

      release()
      await flushPromises()

      expect(setVolume).toHaveBeenCalledTimes(2)
      expect(setVolume).toHaveBeenLastCalledWith('sonos', 'Kitchen', 70)
    })

    describe('several speakers', () => {
      function castToTwo() {
        const connect = useConnectStore()
        vi.spyOn(connect, 'getDeviceVolume').mockImplementation(async (_type, name) =>
          name === 'Kitchen' ? 20 : 40,
        )
        const setVolume = vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
        castTo([
          { name: 'Kitchen', volume: 20 },
          { name: 'Study', volume: 40 },
        ])
        return setVolume
      }

      it('has a master that evens them out in "same level" mode, and no level per speaker', async () => {
        useGroupVolumeStore().setMode('equal')
        const setVolume = castToTwo()
        const wrapper = mountPicker()
        await flushPromises()

        const [master, ...rooms] = faders(wrapper)
        expect(master!.props('master')).toBe(true)
        expect(rooms.every((room) => room.props('plain'))).toBe(true)

        master!.vm.$emit('update:modelValue', 37)
        await flushPromises()

        expect(setVolume).toHaveBeenCalledWith('sonos', 'Kitchen', 37)
        expect(setVolume).toHaveBeenCalledWith('sonos', 'Study', 37)
      })

      it('keeps every speaker adjustable in "keep balance" mode, the master showing the spread', async () => {
        useGroupVolumeStore().setMode('relative')
        const setVolume = castToTwo()
        const wrapper = mountPicker()
        await flushPromises()

        const [master, kitchen] = faders(wrapper)
        expect(master!.text()).toContain('20–40%')
        expect(kitchen!.props('plain')).toBe(false)

        master!.vm.$emit('update:modelValue', 20)
        await flushPromises()
        expect(setVolume).toHaveBeenCalledWith('sonos', 'Kitchen', 10)
        expect(setVolume).toHaveBeenCalledWith('sonos', 'Study', 20)

        kitchen!.vm.$emit('update:modelValue', 15)
        await flushPromises()
        expect(setVolume).toHaveBeenLastCalledWith('sonos', 'Kitchen', 15)
      })

      it('switches the mode from the menu, and remembers it', async () => {
        castToTwo()
        const wrapper = mountPicker()
        await flushPromises()

        await wrapper
          .findComponent({ name: 'SegmentedControl' })
          .vm.$emit('update:modelValue', 'relative')

        expect(useGroupVolumeStore().mode).toBe('relative')
      })

      it('offers no mode switch for a single speaker, where both would do the same', () => {
        castTo([{ name: 'Kitchen' }])
        const wrapper = mountPicker()

        expect(wrapper.findComponent({ name: 'SegmentedControl' }).exists()).toBe(false)
      })
    })
  })

  describe('keeping the list fresh', () => {
    it('polls refreshDevices() every 4s while mounted, and stops on unmount', async () => {
      const connect = useConnectStore()
      const refreshSpy = vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
      const wrapper = mountPicker()

      await vi.advanceTimersByTimeAsync(4000)
      expect(refreshSpy).toHaveBeenCalledTimes(1)
      expect(refreshSpy).toHaveBeenLastCalledWith()

      wrapper.unmount()
      refreshSpy.mockClear()
      await vi.advanceTimersByTimeAsync(8000)
      expect(refreshSpy).not.toHaveBeenCalled()
    })

    it('skips the poll while the app is being denied, and resumes when it stops', async () => {
      // Nothing can arrive during a ban, but the asking is what keeps the
      // ban's own bucket topped up — see pollGate.ts.
      const connect = useConnectStore()
      const refreshSpy = vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
      mountPicker()

      noteResponseStatus(403, { get: () => null }, null)
      await vi.advanceTimersByTimeAsync(8000)
      expect(refreshSpy).not.toHaveBeenCalled()

      noteResponseStatus(200, { get: () => null }, null)
      await vi.advanceTimersByTimeAsync(4000)
      expect(refreshSpy).toHaveBeenCalled()
    })

    it('skips the poll while nobody can see the picker', async () => {
      const connect = useConnectStore()
      const refreshSpy = vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
      mountPicker()

      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      })
      await vi.advanceTimersByTimeAsync(8000)
      expect(refreshSpy).not.toHaveBeenCalled()
    })
  })

  it('shows the api-unreachable banner and retries a fresh scan from it', async () => {
    const connect = useConnectStore()
    connect.errors.apiUnreachable = true
    const wrapper = mountPicker()
    const refreshSpy = vi.spyOn(connect, 'refreshDevices').mockResolvedValue()

    await wrapper.findComponent({ name: 'ConnectErrorBanner' }).vm.$emit('retry')

    expect(refreshSpy).toHaveBeenCalledWith(true)
  })
})
