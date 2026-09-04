import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { useConnectStore } from '@/stores/connect'
import MobileDeviceRow from '../MobileDeviceRow.vue'
import type { DeviceType } from '@/services/connect/types'
import { makeStatus } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function mountRow(
  device: Record<string, unknown> = { name: 'Kitchen' },
  type: DeviceType = 'sonos',
  selected = false,
) {
  return mount(MobileDeviceRow, {
    props: { device, type, selected },
    global: { plugins: [vuetify, i18n] },
  })
}

/** `push` mirrors the backend's own per-device volume_push flag (see
 * connect/core/device_volume.py): true for a device that reports its own
 * volume changes, which is what stops this client polling it. */
function castTo(name: string, type: DeviceType, volume?: number, push = type === 'sonos') {
  useConnectStore().status = makeStatus({
    targets: [{ name, type, volume, volume_push: push }],
  })
}

describe('MobileDeviceRow', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('tapping the row', () => {
    it('asks the picker to toggle this device — the row owns no selection state of its own', async () => {
      const wrapper = mountRow()

      await wrapper.get('.mobile-device-row__main').trigger('click')

      expect(wrapper.emitted('toggle')).toHaveLength(1)
    })

    it('shows a check for the selected device', async () => {
      expect(mountRow().find('.mdi-check-circle').exists()).toBe(false)
      expect(mountRow({ name: 'Kitchen' }, 'sonos', true).find('.mdi-check-circle').exists()).toBe(
        true,
      )
    })

    it('does nothing for an unpaired AirPlay device, which cannot be paired from here', async () => {
      const wrapper = mountRow({ name: 'Bedroom', needs_pairing: true }, 'airplay')

      expect(wrapper.text()).toContain('Needs pairing in the Beacon app first')
      expect(wrapper.get('.mobile-device-row__main').classes()).toContain(
        'mobile-device-row__main--disabled',
      )

      await wrapper.get('.mobile-device-row__main').trigger('click')
      expect(wrapper.emitted('toggle')).toBeUndefined()
    })

    it('does nothing while another session holds the device — take-over is its own button', async () => {
      const wrapper = mountRow({
        name: 'Kitchen',
        in_use_by_session_id: 'someone-else',
        in_use_by_name: 'Anna',
      })

      expect(wrapper.get('.device-row__claimed').text()).toBe('In use by Anna')

      await wrapper.get('.mobile-device-row__main').trigger('click')
      expect(wrapper.emitted('toggle')).toBeUndefined()

      await wrapper.get('button').trigger('click')
      expect(wrapper.emitted('take-over')).toHaveLength(1)
      // The row tap underneath must not have fired as well.
      expect(wrapper.emitted('toggle')).toBeUndefined()
    })

    it('is a plain selectable row again when this session is the one holding it', async () => {
      useAuthStore().sessionId = 'mine'
      const wrapper = mountRow({ name: 'Kitchen', in_use_by_session_id: 'mine' })

      await wrapper.get('.mobile-device-row__main').trigger('click')

      expect(wrapper.find('.device-row__claimed').exists()).toBe(false)
      expect(wrapper.emitted('toggle')).toHaveLength(1)
    })
  })

  describe('volume', () => {
    it('appears only once this device is actually casting, without waiting for a hover it can never get', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      const wrapper = mountRow()

      expect(wrapper.find('.mobile-device-row__volume').exists()).toBe(false)

      castTo('Kitchen', 'sonos')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.mobile-device-row__volume').exists()).toBe(true)
    })

    it('stays away for AirPlay, which has no per-device volume endpoint at all', async () => {
      castTo('Bedroom', 'airplay')
      const connect = useConnectStore()
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      const wrapper = mountRow({ name: 'Bedroom' }, 'airplay')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.mobile-device-row__volume').exists()).toBe(false)
      // ...and isn't asked for a reading it could never show either.
      expect(getVolumeSpy).not.toHaveBeenCalled()
    })

    // Chromecast has no push channel (connectStore.isVolumePushCapable()),
    // so this exercises the polling fallback specifically.
    it('polls a non-push-capable device every 4s while casting, and stops on unmount', async () => {
      vi.useFakeTimers()
      const connect = useConnectStore()
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      castTo('Living Room', 'chromecast')
      const wrapper = mountRow({ name: 'Living Room' }, 'chromecast')
      await vi.runOnlyPendingTimersAsync()

      expect(getVolumeSpy).toHaveBeenCalledWith('chromecast', 'Living Room')
      expect(wrapper.get('.mobile-device-row__volume-value').text()).toBe('30%')

      getVolumeSpy.mockClear()
      await vi.advanceTimersByTimeAsync(4000)
      expect(getVolumeSpy).toHaveBeenCalledOnce()

      wrapper.unmount()
      getVolumeSpy.mockClear()
      await vi.advanceTimersByTimeAsync(8000)
      expect(getVolumeSpy).not.toHaveBeenCalled()
    })

    // Regression test: this surface kept polling every 4s for Sonos too,
    // long after the push channel existed — caught live 2026-08-25.
    it('fetches once for a push-capable device, then takes further readings from the pushed status', async () => {
      vi.useFakeTimers()
      const connect = useConnectStore()
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      castTo('Kitchen', 'sonos', 30)
      const wrapper = mountRow()
      await vi.runOnlyPendingTimersAsync()

      expect(getVolumeSpy).toHaveBeenCalledOnce()
      expect(wrapper.get('.mobile-device-row__volume-value').text()).toBe('30%')

      getVolumeSpy.mockClear()
      await vi.advanceTimersByTimeAsync(8000)
      expect(getVolumeSpy).not.toHaveBeenCalled()

      castTo('Kitchen', 'sonos', 55)
      await wrapper.vm.$nextTick()
      expect(wrapper.get('.mobile-device-row__volume-value').text()).toBe('55%')
      expect(getVolumeSpy).not.toHaveBeenCalled()
    })

    it('keeps the last real reading when a status arrives without one', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(42)
      castTo('Kitchen', 'sonos', 42)
      const wrapper = mountRow()
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()

      castTo('Kitchen', 'sonos')
      await wrapper.vm.$nextTick()

      expect(wrapper.get('.mobile-device-row__volume-value').text()).toBe('42%')
    })

    it('shows a placeholder and a disabled slider for a device that reports no volume', async () => {
      const connect = useConnectStore()
      // e.g. a DLNA renderer without volume support — see routes/volume.py.
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(null)
      castTo('TV', 'dlna')
      const wrapper = mountRow({ name: 'TV' }, 'dlna')
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()

      expect(wrapper.get('.mobile-device-row__volume-value').text()).toBe('–')
      expect(wrapper.getComponent({ name: 'VSlider' }).props('disabled')).toBe(true)
    })

    // Unlike DeviceListItem.vue, this row talks to the store itself rather
    // than handing a volume-change up to its parent.
    it('sets the rounded volume on the device directly, and shows it before the round trip returns', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      const setVolumeSpy = vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
      castTo('Kitchen', 'sonos')
      const wrapper = mountRow()
      await wrapper.vm.$nextTick()

      await wrapper.getComponent({ name: 'VSlider' }).vm.$emit('update:modelValue', 42.6)

      expect(setVolumeSpy).toHaveBeenCalledWith('sonos', 'Kitchen', 43)
      expect(wrapper.get('.mobile-device-row__volume-value').text()).toBe('43%')
    })
  })
})
