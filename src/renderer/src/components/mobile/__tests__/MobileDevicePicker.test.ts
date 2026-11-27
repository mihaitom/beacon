import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import { makeStatus } from '@/stores/__tests__/fixtures'
import { emitter } from '@/emitter'
import { _resetPollGate } from '@/services/connect/pollGate'
import MobileDevicePicker from '../MobileDevicePicker.vue'
import AvailableDeviceRow from '@/components/connect/AvailableDeviceRow.vue'
import ConnectErrorBanner from '@/components/connect/ConnectErrorBanner.vue'
import StreamInfoSection from '@/components/connect/StreamInfoSection.vue'
import VolumeFader from '@/components/connect/VolumeFader.vue'

const vuetify = createVuetify({ components, directives })

// v-bottom-sheet teleports its content to the document body, so the sheet's
// own elements are found through document, its components through the
// wrapper.
function mountPicker(open = true) {
  return mount(MobileDevicePicker, {
    props: { modelValue: open },
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      stubs: { AirplayPairingDialog: true },
      // $emitter is a global property (see main.ts), not something a
      // bare mount() sets up.
      mocks: { $emitter: emitter },
    },
  })
}

function $(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector)
  if (!element) throw new Error(`nothing matches ${selector}`)
  return element
}

function withDevices(sonos: string[]) {
  const connect = useConnectStore()
  connect.devices = {
    sonos: sonos.map((name) => ({ name })),
    airplay: [],
    chromecast: [],
    dlna: [],
  } as unknown as typeof connect.devices
  vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
  return connect
}

function closed(wrapper: ReturnType<typeof mountPicker>): boolean {
  return (wrapper.emitted('update:modelValue') ?? []).some(([value]) => value === false)
}

function pointer(type: string, clientY: number, timeStamp: number): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, clientY, button: 0 }) as PointerEvent
  Object.defineProperty(event, 'pointerId', { value: 1 })
  Object.defineProperty(event, 'timeStamp', { value: timeStamp })
  return event
}

function pull(distance: number, durationMs: number) {
  const top = $('.cast-sheet__top')
  top.dispatchEvent(pointer('pointerdown', 100, 0))
  top.dispatchEvent(pointer('pointermove', 100 + distance, durationMs))
  top.dispatchEvent(pointer('pointerup', 100 + distance, durationMs))
}

describe('MobileDevicePicker', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    _resetPollGate()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('adds a speaker with one tap and stays open to set its volume', async () => {
    withDevices(['Kitchen', 'Living Room'])
    const apply = vi.spyOn(usePlaybackStore(), 'applyTargets').mockResolvedValue()
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()

    await wrapper.findAllComponents(AvailableDeviceRow)[0]!.vm.$emit('add')
    await flushPromises()

    expect(apply).toHaveBeenCalledWith([{ type: 'sonos', name: 'Kitchen' }])
    expect(closed(wrapper)).toBe(false)
  })

  it('lists the speakers playing as volume rows and the rest to add', async () => {
    const connect = withDevices(['Kitchen', 'Living Room'])
    connect.status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAllComponents(VolumeFader).map((f) => f.props('label'))).toEqual(['Kitchen'])
    expect(
      wrapper.findAllComponents(AvailableDeviceRow).map((r) => r.props('device').name),
    ).toEqual(['Living Room'])
  })

  it('toasts a failure that left nothing for its own alert', async () => {
    withDevices(['Kitchen'])
    vi.spyOn(usePlaybackStore(), 'applyTargets').mockRejectedValue(new Error('boom'))
    const toast = vi.fn()
    emitter.on('toast', toast)
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()

    await wrapper.getComponent(AvailableDeviceRow).vm.$emit('add')
    await flushPromises()

    expect(toast).toHaveBeenCalledTimes(1)
    emitter.off('toast', toast)
  })

  it('does not toast what the alert at the top already says', async () => {
    const connect = withDevices(['Kitchen'])
    vi.spyOn(usePlaybackStore(), 'applyTargets').mockImplementation(async () => {
      connect.errors.message = 'Kitchen did not answer'
      throw new Error('boom')
    })
    const toast = vi.fn()
    emitter.on('toast', toast)
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()

    await wrapper.getComponent(AvailableDeviceRow).vm.$emit('add')
    await flushPromises()

    expect(toast).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Kitchen did not answer')
    emitter.off('toast', toast)
  })

  it('stops everything and closes, nothing being left to adjust', async () => {
    const connect = withDevices(['Kitchen'])
    connect.status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
    const stop = vi.spyOn(connect, 'stopAll').mockResolvedValue()
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()

    $('.cast-sheet__stop').click()
    await flushPromises()

    expect(stop).toHaveBeenCalledTimes(1)
    expect(closed(wrapper)).toBe(true)
  })

  it('brings the sound back to the phone from its own row, and closes', async () => {
    const connect = withDevices(['Kitchen'])
    connect.status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
    const stop = vi.spyOn(connect, 'stopAll').mockResolvedValue()
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()

    $('.cast-sheet__local').click()
    await flushPromises()

    expect(stop).toHaveBeenCalledTimes(1)
    expect(closed(wrapper)).toBe(true)
  })

  it('names the phone as where the sound is while nothing is cast, with nothing to stop', async () => {
    withDevices(['Kitchen'])
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()

    expect(document.querySelector('.cast-sheet__here')).not.toBeNull()
    expect(document.querySelector('.cast-sheet__stop')).toBeNull()
    expect(wrapper.findComponent(VolumeFader).exists()).toBe(false)
  })

  describe('closing', () => {
    it('closes from its close button', async () => {
      withDevices([])
      const wrapper = mountPicker()
      await wrapper.vm.$nextTick()

      $('.cast-sheet__head button[aria-label="Close"]').click()

      expect(closed(wrapper)).toBe(true)
    })

    it('closes when pulled down far enough', async () => {
      withDevices([])
      const wrapper = mountPicker()
      await wrapper.vm.$nextTick()

      pull(150, 600)

      expect(closed(wrapper)).toBe(true)
    })

    it('closes on a quick flick that travels only a little', async () => {
      withDevices([])
      const wrapper = mountPicker()
      await wrapper.vm.$nextTick()

      pull(40, 40)

      expect(closed(wrapper)).toBe(true)
    })

    it('springs back from a short, slow pull', async () => {
      withDevices([])
      const wrapper = mountPicker()
      await wrapper.vm.$nextTick()

      pull(40, 600)
      await wrapper.vm.$nextTick()

      expect(closed(wrapper)).toBe(false)
      expect($('.cast-sheet').style.transform).toBe('')
    })
  })

  it('asks for the device list when it opens', async () => {
    const connect = withDevices([])
    const refresh = connect.refreshDevices as unknown as ReturnType<typeof vi.fn>
    const wrapper = mountPicker(false)
    expect(refresh).not.toHaveBeenCalled()

    await wrapper.setProps({ modelValue: true })

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not keep polling the device list while it is closed', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    const connect = withDevices([])
    const refresh = connect.refreshDevices as unknown as ReturnType<typeof vi.fn>
    mountPicker(false)

    await vi.advanceTimersByTimeAsync(8000)

    expect(refresh).not.toHaveBeenCalled()
  })

  it('says the backend is unreachable rather than showing an empty sheet', async () => {
    const connect = withDevices([])
    connect.errors.apiUnreachable = true
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(ConnectErrorBanner).exists()).toBe(true)
  })

  it('kicks off a fresh scan from the rescan button', async () => {
    const connect = withDevices([])
    const refresh = connect.refreshDevices as unknown as ReturnType<typeof vi.fn>
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()
    refresh.mockClear()

    $('.mobile-device-picker__rescan').click()

    expect(refresh).toHaveBeenCalledWith(true)
  })

  it('ends with what is being sent while casting', async () => {
    const connect = withDevices(['Kitchen'])
    connect.status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(StreamInfoSection).exists()).toBe(true)
  })
})
