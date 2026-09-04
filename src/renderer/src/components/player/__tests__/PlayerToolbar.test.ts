import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useConnectStore } from '@/stores/connect'
import PlayerToolbar from '../PlayerToolbar.vue'
import { _resetVolumeGuards } from '@/services/connect/volumeGuard'
import { makeStatus } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function mountToolbar(props: Record<string, unknown> = {}) {
  return mount(PlayerToolbar, {
    props,
    global: {
      plugins: [vuetify, i18n],
      stubs: { ConnectButton: true, RemoteControlButton: true },
    },
  })
}

/** A real wheel event over the volume slider, so the test can also check
 * whether the toolbar claimed it (preventDefault) or left it alone. */
function scroll(wrapper: ReturnType<typeof mountToolbar>, deltaY: number): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, cancelable: true, bubbles: true })
  wrapper.getComponent({ name: 'VSlider' }).element.dispatchEvent(event)
  return event
}

describe('PlayerToolbar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Module-level and keyed by device (see volumeGuard.ts) — a settle
    // window left over from one test would swallow the next one's readings.
    _resetVolumeGuards()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('remote control button (Electron-only)', () => {
    const originalApi = window.api

    afterEach(() => {
      window.api = originalApi
    })

    it('is hidden in the web build (no window.api)', () => {
      window.api = undefined as unknown as typeof window.api
      const wrapper = mountToolbar()

      expect(wrapper.findComponent({ name: 'RemoteControlButton' }).exists()).toBe(false)
    })

    it('is shown in Electron (window.api present)', () => {
      window.api = {} as typeof window.api
      const wrapper = mountToolbar()

      expect(wrapper.findComponent({ name: 'RemoteControlButton' }).exists()).toBe(true)
    })
  })

  describe('mute/volume (local playback)', () => {
    // Awaited because the mute itself lives in volumeControl.ts now (shared
    // with the M shortcut, so both remember the same pre-mute volume), and
    // reading the current volume there can involve a round trip to a cast
    // device.
    it('mutes to 0 and restores the previous volume on toggle', async () => {
      const wrapper = mountToolbar()
      const playback = usePlaybackStore()
      const setVolumeSpy = vi.spyOn(playback, 'setVolume')
      playback.volume = 0.6

      const vm = wrapper.vm as unknown as { toggleMute(): Promise<void> }
      await vm.toggleMute()
      expect(setVolumeSpy).toHaveBeenLastCalledWith(0)

      playback.volume = 0
      await vm.toggleMute()
      expect(setVolumeSpy).toHaveBeenLastCalledWith(0.6)
    })

    it('is adjustable by mouse wheel, in 5% steps', async () => {
      const wrapper = mountToolbar()
      const playback = usePlaybackStore()
      const setVolumeSpy = vi.spyOn(playback, 'setVolume')
      playback.volume = 0.5
      await wrapper.vm.$nextTick()

      const up = scroll(wrapper, -120)
      expect(setVolumeSpy).toHaveBeenLastCalledWith(0.55)
      // Claimed, so the page doesn't scroll along with it.
      expect(up.defaultPrevented).toBe(true)

      playback.volume = 0.55
      await wrapper.vm.$nextTick()
      scroll(wrapper, 120)
      expect(setVolumeSpy).toHaveBeenLastCalledWith(0.5)
    })

    it('ignores the wheel while casting, when the local slider controls nothing', async () => {
      const wrapper = mountToolbar()
      const playback = usePlaybackStore()
      const setVolumeSpy = vi.spyOn(playback, 'setVolume')
      // Two targets: no single device to control from here either, so this
      // is the (disabled) local slider.
      useConnectStore().status = makeStatus({
        targets: [
          { name: 'Kitchen', type: 'sonos', volume_push: true },
          { name: 'Living Room', type: 'sonos', volume_push: true },
        ],
      })
      await wrapper.vm.$nextTick()

      const event = scroll(wrapper, -120)

      expect(setVolumeSpy).not.toHaveBeenCalled()
      expect(event.defaultPrevented).toBe(false)
    })

    it('formats the volume label as a rounded percentage', async () => {
      const wrapper = mountToolbar()
      const playback = usePlaybackStore()
      playback.volume = 0.42
      await wrapper.vm.$nextTick()

      expect(wrapper.get('.volume-value').text()).toBe('42%')
    })
  })

  describe('mute/volume (single cast target)', () => {
    // Chromecast has no push channel (connectStore.isVolumePushCapable()),
    // so this exercises the polling fallback specifically.
    it('fetches and polls the device volume while exactly one target is active, and stops polling on unmount', async () => {
      vi.useFakeTimers()
      const wrapper = mountToolbar()
      const connect = useConnectStore()
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      connect.status = makeStatus({ targets: [{ name: 'Living Room', type: 'chromecast' }] })
      await wrapper.vm.$nextTick()
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

    // Regression test: Sonos volume/mute reaches connectStore.status by
    // push (see connectStore.isVolumePushCapable()) - this used to still
    // poll every 4s regardless of type, one of several surfaces that
    // silently kept doing so after DeviceListItem.vue's own fix, caught
    // live 2026-08-25.
    it('fetches once for a push-capable target, then relies on pushed updates instead of polling', async () => {
      vi.useFakeTimers()
      const wrapper = mountToolbar()
      const connect = useConnectStore()
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      connect.status = makeStatus({
        targets: [{ name: 'Living Room', type: 'sonos', volume: 30, volume_push: true }],
      })
      await wrapper.vm.$nextTick()
      await vi.runOnlyPendingTimersAsync()

      expect(getVolumeSpy).toHaveBeenCalledOnce()
      expect(wrapper.get('.volume-value').text()).toBe('30%')

      getVolumeSpy.mockClear()
      await vi.advanceTimersByTimeAsync(8000)
      expect(getVolumeSpy).not.toHaveBeenCalled()

      // A push (e.g. the Sonos app, another session) updates the slider
      // without any request from this client at all.
      connect.status = makeStatus({
        targets: [{ name: 'Living Room', type: 'sonos', volume: 55, volume_push: true }],
      })
      await wrapper.vm.$nextTick()
      expect(wrapper.get('.volume-value').text()).toBe('55%')
      expect(getVolumeSpy).not.toHaveBeenCalled()
    })

    describe('not fighting the person setting it', () => {
      // Reported live 2026-09-04: the slider bounced back every so often.
      // The device's own readings (a 4s poll here, a push for Sonos) were
      // being applied on top of what the user had just done, carrying the
      // value from before the change.
      async function castTo(type: 'chromecast' | 'sonos', volume = 30) {
        const wrapper = mountToolbar()
        const connect = useConnectStore()
        const getVolume = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(volume)
        vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
        connect.status = makeStatus({ targets: [{ name: 'Kitchen', type, volume }] })
        await wrapper.vm.$nextTick()
        await vi.runOnlyPendingTimersAsync()
        return { wrapper, connect, getVolume }
      }

      it('does not let a poll that was already in flight pull the slider back', async () => {
        // The actual race: the 4s poll goes out, the user moves the slider
        // while it is on the wire, and the answer describes the level from
        // before they touched it.
        vi.useFakeTimers()
        const { wrapper, getVolume } = await castTo('chromecast')
        let answerPoll!: (volume: number) => void
        getVolume.mockReturnValue(
          new Promise<number>((resolve) => {
            answerPoll = resolve
          }),
        )
        await vi.advanceTimersByTimeAsync(4000)

        wrapper.getComponent({ name: 'VSlider' }).vm.$emit('update:modelValue', 70)
        await wrapper.vm.$nextTick()
        expect(wrapper.get('.volume-value').text()).toBe('70%')

        answerPoll(30)
        // Microtasks only — advancing the clock here would step past the
        // settle window and change what is being tested.
        await flushPromises()

        expect(wrapper.get('.volume-value').text()).toBe('70%')
      })

      it('does not even ask again while the level is being set', async () => {
        vi.useFakeTimers()
        const { wrapper, getVolume } = await castTo('chromecast')

        // A drag that pauses mid-way: the pointer is still down, so the
        // poll that falls in the middle of it must not answer over it.
        wrapper.getComponent({ name: 'VSlider' }).vm.$emit('start', 30)
        wrapper.getComponent({ name: 'VSlider' }).vm.$emit('update:modelValue', 70)
        await wrapper.vm.$nextTick()
        getVolume.mockClear()

        await vi.advanceTimersByTimeAsync(8000)

        expect(getVolume).not.toHaveBeenCalled()
        expect(wrapper.get('.volume-value').text()).toBe('70%')
      })

      it('takes the device at its word again once it has had time to catch up', async () => {
        vi.useFakeTimers()
        const { wrapper, getVolume } = await castTo('chromecast')
        wrapper.getComponent({ name: 'VSlider' }).vm.$emit('update:modelValue', 70)
        await wrapper.vm.$nextTick()

        // Someone turns the dial on the speaker itself a few seconds later:
        // that has to reach the slider, or it would be stuck for good.
        getVolume.mockResolvedValue(45)
        await vi.advanceTimersByTimeAsync(8000)

        expect(wrapper.get('.volume-value').text()).toBe('45%')
      })

      it('ignores a pushed reading for as long as the drag lasts', async () => {
        vi.useFakeTimers()
        const { wrapper, connect } = await castTo('sonos')
        const slider = wrapper.getComponent({ name: 'VSlider' })

        slider.vm.$emit('start', 30)
        slider.vm.$emit('update:modelValue', 80)
        await wrapper.vm.$nextTick()

        // A push carrying the pre-drag level arrives mid-drag.
        connect.status = makeStatus({
          targets: [{ name: 'Kitchen', type: 'sonos', volume: 30, volume_push: true }],
        })
        await wrapper.vm.$nextTick()
        expect(wrapper.get('.volume-value').text()).toBe('80%')

        // Let go, wait out the settle window, and pushes count again.
        slider.vm.$emit('end', 80)
        await vi.advanceTimersByTimeAsync(4000)
        connect.status = makeStatus({
          targets: [{ name: 'Kitchen', type: 'sonos', volume: 25, volume_push: true }],
        })
        await wrapper.vm.$nextTick()

        expect(wrapper.get('.volume-value').text()).toBe('25%')
      })
    })

    it('sends a wheel adjustment to the device, not the local player', async () => {
      const wrapper = mountToolbar()
      const connect = useConnectStore()
      const playback = usePlaybackStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(50)
      const setDeviceVolumeSpy = vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
      const setLocalVolumeSpy = vi.spyOn(playback, 'setVolume')
      connect.status = makeStatus({
        targets: [{ name: 'Kitchen', type: 'sonos', volume_push: true }],
      })
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()

      scroll(wrapper, -120)
      await wrapper.vm.$nextTick()

      expect(setDeviceVolumeSpy).toHaveBeenCalledWith('sonos', 'Kitchen', 55)
      expect(setLocalVolumeSpy).not.toHaveBeenCalled()
      expect(wrapper.get('.volume-value').text()).toBe('55%')
    })

    it('never asks an AirPlay target for a volume it has no endpoint for', async () => {
      vi.useFakeTimers()
      const wrapper = mountToolbar()
      const connect = useConnectStore()
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      connect.status = makeStatus({ targets: [{ name: 'Bedroom', type: 'airplay' }] })
      await wrapper.vm.$nextTick()
      await vi.advanceTimersByTimeAsync(8000)

      expect(getVolumeSpy).not.toHaveBeenCalled()
      expect(wrapper.get('.volume-value').text()).toBe('—')
    })

    it('mutes/unmutes the device via setDeviceVolume instead of the local store', async () => {
      const wrapper = mountToolbar()
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(50)
      const setVolumeSpy = vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
      connect.status = makeStatus({
        targets: [{ name: 'Kitchen', type: 'sonos', volume_push: true }],
      })
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()

      const vm = wrapper.vm as unknown as { toggleMute(): Promise<void> }
      await vm.toggleMute()
      expect(setVolumeSpy).toHaveBeenLastCalledWith('sonos', 'Kitchen', 0)

      await vm.toggleMute()
      expect(setVolumeSpy).toHaveBeenLastCalledWith('sonos', 'Kitchen', 50)
    })
  })

  describe('volumeCollapsed', () => {
    it('shows the inline slider + label when false', () => {
      const wrapper = mountToolbar({ volumeCollapsed: false })

      expect(wrapper.find('.volume-slider').exists()).toBe(true)
      expect(wrapper.find('.volume-value').exists()).toBe(true)
    })

    it('folds the slider into a popover behind the mute icon when true', async () => {
      const wrapper = mountToolbar({ volumeCollapsed: true })

      expect(wrapper.find('.volume-slider').exists()).toBe(false)

      const activator = wrapper.get('.mdi-volume-high, .mdi-volume-mute').element.closest('button')!
      activator.dispatchEvent(new Event('click', { bubbles: true }))
      await wrapper.vm.$nextTick()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(document.querySelector('.volume-popover .volume-slider')).not.toBeNull()
    })
  })
})
