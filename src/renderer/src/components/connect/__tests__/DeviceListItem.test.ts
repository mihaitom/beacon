import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { useConnectStore } from '@/stores/connect'
import DeviceListItem from '../DeviceListItem.vue'
import type { DeviceType } from '@/services/connect/types'
import { makeStatus } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function mountItem(
  device: Record<string, unknown> = { name: 'Kitchen' },
  type: DeviceType = 'sonos',
  selected = false,
) {
  return mount(DeviceListItem, {
    props: { device, type, selected },
    global: { plugins: [vuetify, i18n] },
  })
}

/** The switch reports through a plain <input>'s `input` event (see
 * Vuetify's VSelectionControl) — a click's activation behaviour is what
 * flips `checked` in a real browser, so a test has to set it itself. */
async function flipSwitch(wrapper: ReturnType<typeof mountItem>, checked: boolean) {
  const input = wrapper.get('.device-row__switch input')
  ;(input.element as HTMLInputElement).checked = checked
  await input.trigger('input')
}

/** A real wheel event, so the test can also check whether the component
 * claimed it (preventDefault) or left it to the scrolling device list. */
function scroll(wrapper: ReturnType<typeof mountItem>, deltaY: number): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, cancelable: true, bubbles: true })
  wrapper.getComponent({ name: 'VSlider' }).element.dispatchEvent(event)
  return event
}

/** Marks this device as one of the session's live cast targets, which is
 * what every volume affordance here is gated on. */
function castTo(name: string, type: DeviceType, volume?: number) {
  useConnectStore().status = makeStatus({ targets: [{ name, type, volume }] })
}

describe('DeviceListItem', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('selection', () => {
    it('reports a toggle as an edit to the parent-owned selection instead of acting on the device', async () => {
      const wrapper = mountItem()

      await flipSwitch(wrapper, true)

      expect(wrapper.emitted('update:selected')).toEqual([[true]])
    })

    it('unchecking an active target also only stages it — nothing is stopped from here', async () => {
      castTo('Kitchen', 'sonos')
      const connect = useConnectStore()
      const stopSpy = vi.spyOn(connect, 'stopDevice').mockResolvedValue()
      const wrapper = mountItem({ name: 'Kitchen' }, 'sonos', true)

      await flipSwitch(wrapper, false)

      // Regression test: an immediate stop here is what dropped playback to
      // local while switching between two devices.
      expect(stopSpy).not.toHaveBeenCalled()
      expect(wrapper.emitted('update:selected')).toEqual([[false]])
    })

    it('clicking the row body toggles it too, so the whole row is the target', async () => {
      const wrapper = mountItem()

      await wrapper.get('.device-row__info').trigger('click')

      expect(wrapper.emitted('update:selected')).toEqual([[true]])
    })

    it('ignores a row-body click on an active target, so a mis-tap cannot stop playback', async () => {
      castTo('Kitchen', 'sonos')
      const wrapper = mountItem({ name: 'Kitchen' }, 'sonos', true)

      await wrapper.get('.device-row__info').trigger('click')

      expect(wrapper.emitted('update:selected')).toBeUndefined()
    })

    it('cannot be selected at all while another session holds the device', async () => {
      const wrapper = mountItem({ name: 'Kitchen', in_use_by_session_id: 'someone-else' })

      await flipSwitch(wrapper, true)
      await wrapper.get('.device-row__info').trigger('click')

      expect(wrapper.emitted('update:selected')).toBeUndefined()
    })
  })

  describe('claimed by another session', () => {
    it('names the owner and what they are playing, and offers a take-over', async () => {
      const wrapper = mountItem({
        name: 'Kitchen',
        in_use_by_session_id: 'someone-else',
        in_use_by_name: 'Anna',
        in_use_by_song: 'Some Song',
      })

      expect(wrapper.get('.device-row__claimed').text()).toBe('In use by Anna')
      expect(wrapper.text()).toContain('Some Song')

      const takeOverBtn = wrapper.findAll('button').find((b) => b.text().includes('Take over'))!
      await takeOverBtn.trigger('click')

      expect(wrapper.emitted('take-over')).toEqual([[wrapper.props('device')]])
    })

    it('falls back to an anonymous label when the owner has no name', () => {
      const wrapper = mountItem({ name: 'Kitchen', in_use_by_session_id: 'someone-else' })

      expect(wrapper.get('.device-row__claimed').text()).toBe('In use by someone else')
    })

    it('is not "claimed" when this very session is the owner', () => {
      useAuthStore().sessionId = 'mine'
      const wrapper = mountItem({ name: 'Kitchen', in_use_by_session_id: 'mine' })

      expect(wrapper.find('.device-row__claimed').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Take over')
    })
  })

  describe('pairing', () => {
    it('offers pairing only for an AirPlay device that still needs it', () => {
      expect(mountItem({ name: 'Bedroom', needs_pairing: true }, 'airplay').text()).toContain(
        'Pair',
      )
      expect(mountItem({ name: 'Bedroom' }, 'airplay').text()).not.toContain('Pair')
      // needs_pairing is AirPlay-only; no other type should ever show it
      // even if the flag somehow came back set.
      expect(mountItem({ name: 'Kitchen', needs_pairing: true }, 'sonos').text()).not.toContain(
        'Pair',
      )
    })

    it('emits pair with the device instead of starting the flow itself', async () => {
      const wrapper = mountItem({ name: 'Bedroom', needs_pairing: true }, 'airplay')

      await wrapper
        .findAll('button')
        .find((b) => b.text().includes('Pair'))!
        .trigger('click')

      expect(wrapper.emitted('pair')).toEqual([[wrapper.props('device')]])
    })
  })

  describe('volume', () => {
    it('stays hidden until this device is actually one of the live targets', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      const wrapper = mountItem()

      expect(wrapper.find('.device-row__volume').exists()).toBe(false)

      castTo('Kitchen', 'sonos')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.device-row__volume').exists()).toBe(true)
    })

    it('stays hidden for AirPlay, which has no per-device volume endpoint at all', async () => {
      castTo('Bedroom', 'airplay')
      const connect = useConnectStore()
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      const wrapper = mountItem({ name: 'Bedroom' }, 'airplay')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.device-row__volume').exists()).toBe(false)
      expect(getVolumeSpy).not.toHaveBeenCalled()
    })

    it('opens permanently for a single target, and only on hover once several are casting', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      castTo('Kitchen', 'sonos')
      const wrapper = mountItem()
      await wrapper.vm.$nextTick()

      expect(wrapper.get('.device-row__volume').classes()).toContain('device-row__volume--always')

      connect.status = makeStatus({
        targets: [
          { name: 'Kitchen', type: 'sonos' },
          { name: 'Living Room', type: 'sonos' },
        ],
      })
      await wrapper.vm.$nextTick()

      expect(wrapper.get('.device-row__volume').classes()).not.toContain(
        'device-row__volume--always',
      )
    })

    // Chromecast has no push channel (connectStore.isVolumePushCapable()),
    // so this exercises the polling fallback specifically.
    it('polls a non-push-capable device every 4s while it is casting, and stops on unmount', async () => {
      vi.useFakeTimers()
      const connect = useConnectStore()
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      castTo('Living Room', 'chromecast')
      const wrapper = mountItem({ name: 'Living Room' }, 'chromecast')
      await vi.runOnlyPendingTimersAsync()

      expect(getVolumeSpy).toHaveBeenCalledWith('chromecast', 'Living Room')
      expect(wrapper.get('.volume-value').text()).toBe('30%')

      getVolumeSpy.mockClear()
      await vi.advanceTimersByTimeAsync(4000)
      expect(getVolumeSpy).toHaveBeenCalledOnce()

      wrapper.unmount()
      getVolumeSpy.mockClear()
      await vi.advanceTimersByTimeAsync(8000)
      expect(getVolumeSpy).not.toHaveBeenCalled()
    })

    // Regression test: Sonos volume reaches connectStore.status by push
    // (see connectStore.isVolumePushCapable()) — this kept polling every 4s
    // regardless of type until 2026-08-25.
    it('fetches once for a push-capable device, then takes further readings from the pushed status', async () => {
      vi.useFakeTimers()
      const connect = useConnectStore()
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      castTo('Kitchen', 'sonos', 30)
      const wrapper = mountItem()
      await vi.runOnlyPendingTimersAsync()

      expect(getVolumeSpy).toHaveBeenCalledOnce()
      expect(wrapper.get('.volume-value').text()).toBe('30%')

      getVolumeSpy.mockClear()
      await vi.advanceTimersByTimeAsync(8000)
      expect(getVolumeSpy).not.toHaveBeenCalled()

      // A change made elsewhere (the Sonos app, another session) lands
      // without this client asking for it.
      castTo('Kitchen', 'sonos', 55)
      await wrapper.vm.$nextTick()
      expect(wrapper.get('.volume-value').text()).toBe('55%')
      expect(getVolumeSpy).not.toHaveBeenCalled()
    })

    it('keeps the last real reading when a status arrives without one', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(42)
      castTo('Kitchen', 'sonos', 42)
      const wrapper = mountItem()
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()

      castTo('Kitchen', 'sonos')
      await wrapper.vm.$nextTick()

      expect(wrapper.get('.volume-value').text()).toBe('42%')
    })

    it('shows a placeholder and disables the controls for a device that reports no volume', async () => {
      const connect = useConnectStore()
      // e.g. a DLNA renderer without volume support — see routes/volume.py.
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(null)
      castTo('TV', 'dlna')
      const wrapper = mountItem({ name: 'TV' }, 'dlna')
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()

      expect(wrapper.get('.volume-value').text()).toBe('–')
      expect(wrapper.get('.device-row__volume button').attributes('disabled')).toBeDefined()
    })

    it('reports a slider change as a rounded percentage, and shows it immediately', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      castTo('Kitchen', 'sonos')
      const wrapper = mountItem()
      await wrapper.vm.$nextTick()

      await wrapper.getComponent({ name: 'VSlider' }).vm.$emit('update:modelValue', 42.6)

      expect(wrapper.emitted('volume-change')).toEqual([
        [{ device: { name: 'Kitchen' }, type: 'sonos', volume: 43 }],
      ])
      // Optimistic: the slider doesn't wait for the round trip the parent
      // makes on its behalf.
      expect(wrapper.get('.volume-value').text()).toBe('43%')
    })

    it('is adjustable by mouse wheel, in the same 5% steps as everywhere else', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(50)
      castTo('Kitchen', 'sonos')
      const wrapper = mountItem()
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()

      const up = scroll(wrapper, -120)
      await wrapper.vm.$nextTick()
      expect(wrapper.emitted('volume-change')!.at(-1)).toEqual([
        { device: { name: 'Kitchen' }, type: 'sonos', volume: 55 },
      ])
      expect(wrapper.get('.volume-value').text()).toBe('55%')
      // Claimed, so the device list doesn't scroll the row out from under
      // the pointer at the same time.
      expect(up.defaultPrevented).toBe(true)

      scroll(wrapper, 120)
      await wrapper.vm.$nextTick()
      expect(wrapper.emitted('volume-change')!.at(-1)).toEqual([
        { device: { name: 'Kitchen' }, type: 'sonos', volume: 50 },
      ])
    })

    it('leaves the wheel to the scrolling list when there is no volume to adjust', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(null)
      castTo('TV', 'dlna')
      const wrapper = mountItem({ name: 'TV' }, 'dlna')
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()

      const event = scroll(wrapper, -120)

      expect(wrapper.emitted('volume-change')).toBeUndefined()
      expect(event.defaultPrevented).toBe(false)
    })

    it('mutes to 0 and restores the pre-mute volume on the second click', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(60)
      castTo('Kitchen', 'sonos')
      const wrapper = mountItem()
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()

      const muteBtn = wrapper.get('.device-row__volume button')
      await muteBtn.trigger('click')
      expect(wrapper.emitted('volume-change')!.at(-1)).toEqual([
        { device: { name: 'Kitchen' }, type: 'sonos', volume: 0 },
      ])

      await muteBtn.trigger('click')
      expect(wrapper.emitted('volume-change')!.at(-1)).toEqual([
        { device: { name: 'Kitchen' }, type: 'sonos', volume: 60 },
      ])
    })

    it('unmutes to a sane default when it was already silent before this session saw it', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(0)
      castTo('Kitchen', 'sonos')
      const wrapper = mountItem()
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()

      await wrapper.get('.device-row__volume button').trigger('click')

      expect(wrapper.emitted('volume-change')!.at(-1)).toEqual([
        { device: { name: 'Kitchen' }, type: 'sonos', volume: 50 },
      ])
    })
  })
})
