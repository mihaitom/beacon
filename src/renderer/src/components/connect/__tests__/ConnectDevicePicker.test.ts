import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import ConnectDevicePicker from '../ConnectDevicePicker.vue'
import type { DiscoverResponse } from '@/services/connect/types'
import { makeStatus } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

// DeviceListItem.vue has its own considerable logic (volume polling, pairing
// state, ...) that's out of scope for what ConnectDevicePicker itself is
// responsible for (grouping/sorting devices, selection, the apply/
// take-over/pair wiring) — a minimal stand-in that still exposes the
// real props/events contract keeps these tests about that wiring, not
// DeviceListItem's internals.
const DeviceListItemStub = {
  name: 'DeviceListItem',
  props: ['device', 'type', 'selected'],
  emits: ['update:selected', 'take-over', 'pair', 'volume-change'],
  template: `<div class="device-list-item-stub" :data-name="device.name" :data-type="type">
    {{ device.name }}
  </div>`,
}

function mountPicker() {
  return mount(ConnectDevicePicker, {
    global: {
      plugins: [vuetify, i18n],
      stubs: { DeviceListItem: DeviceListItemStub, AirplayPairingDialog: true },
    },
  })
}

function makeDevices(overrides: Partial<DiscoverResponse> = {}): DiscoverResponse {
  return { sonos: [], airplay: [], chromecast: [], dlna: [], ...overrides }
}

describe('ConnectDevicePicker', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows "no devices found" when the scan came back empty', () => {
    const wrapper = mountPicker()

    expect(wrapper.text()).toContain('No devices found')
    expect(wrapper.findAllComponents(DeviceListItemStub)).toHaveLength(0)
  })

  it('groups devices by type in the fixed Sonos/AirPlay/Chromecast/DLNA order, sorted by name within each group', () => {
    const connect = useConnectStore()
    connect.devices = makeDevices({
      dlna: [{ name: 'Living Room DLNA' }],
      airplay: [{ name: 'Zulu Speaker' }, { name: 'Alpha Speaker' }],
      sonos: [{ name: 'Kitchen' }],
    })
    const wrapper = mountPicker()

    const headings = wrapper.findAll('.device-group-heading').map((h) => h.text())
    expect(headings).toEqual(['Sonos', 'AirPlay', 'DLNA'])

    const items = wrapper.findAllComponents(DeviceListItemStub)
    expect(items.map((i) => i.props('device').name)).toEqual([
      'Kitchen',
      'Alpha Speaker',
      'Zulu Speaker',
      'Living Room DLNA',
    ])
  })

  it('shows the api-unreachable banner and retries a fresh scan from it', async () => {
    const connect = useConnectStore()
    connect.errors.apiUnreachable = true
    const wrapper = mountPicker()
    const refreshSpy = vi.spyOn(connect, 'refreshDevices').mockResolvedValue()

    await wrapper
      .get('.connect-picker')
      .findComponent({ name: 'ConnectErrorBanner' })
      .vm.$emit('retry')

    expect(refreshSpy).toHaveBeenCalledWith(true)
  })

  it('shows a scanning progress bar while isScanning is true', async () => {
    const connect = useConnectStore()
    const wrapper = mountPicker()

    // Not just `.v-progress-linear` — v-card itself always renders one
    // internally for its own (unrelated, unused here) `loading` prop, so a
    // bare class/name match finds that regardless of isScanning. `.mb-2` is
    // this component's own explicit v-if'd one.
    expect(wrapper.find('.v-progress-linear.mb-2').exists()).toBe(false)

    connect.isScanning = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.v-progress-linear.mb-2').exists()).toBe(true)
  })

  describe('selection and connecting', () => {
    beforeEach(() => {
      const connect = useConnectStore()
      connect.devices = makeDevices({ sonos: [{ name: 'Kitchen' }, { name: 'Living Room' }] })
    })

    it('labels the action by what applying would actually do, and hides it when there is nothing to do', async () => {
      const connect = useConnectStore()
      const wrapper = mountPicker()
      const items = wrapper.findAllComponents(DeviceListItemStub)

      // Nothing casting, nothing checked: no action.
      expect(wrapper.text()).not.toContain('Connect')

      await items[0]!.vm.$emit('update:selected', true)
      expect(wrapper.text()).toContain('Connect')

      // That device is now actually casting, so the checked set matches
      // reality and there is nothing left to apply.
      connect.status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
      await wrapper.vm.$nextTick()
      expect(wrapper.get('.connect-picker__actions').text()).not.toContain('Apply')

      // Checking a second device is a real change again — and "Apply", not
      // "+1 more": it reconciles the whole set rather than only adding.
      await items[1]!.vm.$emit('update:selected', true)
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toContain('Apply')
    })

    it('seeds the checkboxes from the live targets, so an untouched picker mirrors reality', async () => {
      const connect = useConnectStore()
      connect.status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
      const wrapper = mountPicker()
      await wrapper.vm.$nextTick()

      expect(wrapper.findAllComponents(DeviceListItemStub).map((i) => i.props('selected'))).toEqual(
        [true, false],
      )
      // Nothing to apply yet — it already matches what is casting.
      expect(wrapper.get('.connect-picker__actions').text()).not.toContain('Apply')
    })

    it('unchecking an active device stages a removal instead of stopping it immediately', async () => {
      const connect = useConnectStore()
      connect.status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
      const stopSpy = vi.spyOn(connect, 'stopDevice').mockResolvedValue()
      const wrapper = mountPicker()
      await wrapper.vm.$nextTick()

      await wrapper.findAllComponents(DeviceListItemStub)[0]!.vm.$emit('update:selected', false)

      // Regression test: this used to stop the device on the spot, which is
      // what made switching devices fall back to local playback in between.
      expect(stopSpy).not.toHaveBeenCalled()
      expect(wrapper.get('.connect-picker__actions').text()).toContain('Stop all')
    })

    it('applies the checked set as the desired targets and re-syncs on success', async () => {
      const wrapper = mountPicker()
      const applySpy = vi.spyOn(usePlaybackStore(), 'applyTargets').mockResolvedValue()
      const items = wrapper.findAllComponents(DeviceListItemStub)
      await items[0]!.vm.$emit('update:selected', true)
      await items[1]!.vm.$emit('update:selected', true)

      await wrapper.get('.connect-picker__actions').findAll('button').at(-1)!.trigger('click')
      await wrapper.vm.$nextTick()

      // applyTargets(), not castTo(): on a running session castTo() would
      // replace the target set, dropping devices that are already playing.
      expect(applySpy).toHaveBeenCalledWith([
        { name: 'Kitchen', type: 'sonos' },
        { name: 'Living Room', type: 'sonos' },
      ])
      // Re-seeded from the (still empty, since applyTargets is mocked)
      // live targets rather than simply cleared.
      expect(wrapper.findAllComponents(DeviceListItemStub).map((i) => i.props('selected'))).toEqual(
        [false, false],
      )
    })

    it('swallows an apply failure instead of leaving an unhandled rejection', async () => {
      const wrapper = mountPicker()
      vi.spyOn(usePlaybackStore(), 'applyTargets').mockRejectedValue(new Error('device in use'))
      const items = wrapper.findAllComponents(DeviceListItemStub)
      await items[0]!.vm.$emit('update:selected', true)

      await expect(
        wrapper.get('.connect-picker__actions').findAll('button').at(-1)!.trigger('click'),
      ).resolves.not.toThrow()
    })
  })

  it('take-over from a row forces castTo() for just that device', async () => {
    const connect = useConnectStore()
    connect.devices = makeDevices({ sonos: [{ name: 'Kitchen' }] })
    const wrapper = mountPicker()
    const castToSpy = vi.spyOn(usePlaybackStore(), 'castTo').mockResolvedValue()

    await wrapper.getComponent(DeviceListItemStub).vm.$emit('take-over')

    expect(castToSpy).toHaveBeenCalledWith([{ name: 'Kitchen', type: 'sonos' }], true)
  })

  it('stop-all is only shown while casting, and calls connectStore.stopAll()', async () => {
    const connect = useConnectStore()
    const wrapper = mountPicker()
    expect(wrapper.text()).not.toContain('Stop all')

    connect.status = {
      current_song: null,
      queue: [],
      current_song_index: -1,
      original_queue: [],
      shuffle: false,
      repeat_mode: 'off',
      elapsed: 0,
      ended: false,
      paused: false,
      radio: null,
      streaming: false,
      targets: [{ name: 'Kitchen', type: 'sonos' }],
      total_songs: 0,
      displaced: false,
    }
    await wrapper.vm.$nextTick()
    const stopAllSpy = vi.spyOn(connect, 'stopAll').mockResolvedValue()

    const stopBtn = [...wrapper.get('.connect-picker__actions').findAll('button')].find((b) =>
      b.text().includes('Stop all'),
    )!
    await stopBtn.trigger('click')

    expect(stopAllSpy).toHaveBeenCalledOnce()
  })

  it('opens the AirPlay pairing dialog for the row that asked for it', async () => {
    const connect = useConnectStore()
    connect.devices = makeDevices({ airplay: [{ name: 'Bedroom' }] })
    const wrapper = mountPicker()

    await wrapper.getComponent(DeviceListItemStub).vm.$emit('pair')

    const dialog = wrapper.getComponent({ name: 'AirplayPairingDialog' })
    expect(dialog.props('modelValue')).toBe(true)
    expect(dialog.props('deviceName')).toBe('Bedroom')
  })

  it("a volume-change event sets that device's volume", async () => {
    const connect = useConnectStore()
    connect.devices = makeDevices({ sonos: [{ name: 'Kitchen' }] })
    const wrapper = mountPicker()
    const setVolumeSpy = vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()

    await wrapper
      .getComponent(DeviceListItemStub)
      .vm.$emit('volume-change', { type: 'sonos', device: { name: 'Kitchen' }, volume: 42 })

    expect(setVolumeSpy).toHaveBeenCalledWith('sonos', 'Kitchen', 42)
  })

  it('polls refreshDevices() every 4s while mounted, and stops on unmount', async () => {
    const connect = useConnectStore()
    const refreshSpy = vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
    const wrapper = mountPicker()

    expect(refreshSpy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4000)
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(refreshSpy).toHaveBeenLastCalledWith()

    wrapper.unmount()
    refreshSpy.mockClear()
    await vi.advanceTimersByTimeAsync(8000)
    expect(refreshSpy).not.toHaveBeenCalled()
  })
})
