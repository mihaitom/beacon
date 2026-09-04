import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import MobileTransportControls from '../MobileTransportControls.vue'
import { getAudioEngine } from '@/services/audioEngine'
import type { DeviceType } from '@/services/connect/types'
import { makeSong, makeStatus } from '@/stores/__tests__/fixtures'

// The volume row asks the engine whether this device's own level can be
// changed at all. jsdom has no AudioContext, so a real engine would always
// answer no and hide the row every test below is about.
vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))

/** `true` is a desktop browser, `false` a phone — where the element's
 * volume is read-only and no Web Audio graph exists to do it instead. */
function withLocalVolume(available: boolean): void {
  vi.mocked(getAudioEngine).mockReturnValue({
    canSetVolume: available,
  } as unknown as ReturnType<typeof getAudioEngine>)
}

const vuetify = createVuetify({ components, directives })

// SongWaveform draws onto a real <canvas> and fetches peaks for the current
// song — neither of which jsdom does, and neither of which this component
// is responsible for. Stubbed to its prop/event contract (model-value +
// @end, deliberately v-slider-shaped) so the seek wiring stays testable.
function mountControls() {
  return mount(MobileTransportControls, {
    global: {
      plugins: [vuetify, i18n],
      stubs: { SongWaveform: true, MobileDevicePicker: true },
    },
  })
}

/** The button carrying a given mdi icon — the transport row is five
 * icon-only buttons, so an index would say nothing about which is which. */
function button(wrapper: ReturnType<typeof mountControls>, icon: string) {
  return wrapper.get(`.${icon}`).element.closest('button')!
}

function castTo(name: string, type: DeviceType, volume?: number) {
  // volume_push mirrors the backend's own per-device flag (see
  // connect/core/device_volume.py) — a device that reports its own volume
  // changes is not polled by this client.
  useConnectStore().status = makeStatus({
    targets: [{ name, type, volume, volume_push: type === 'sonos' }],
  })
}

describe('MobileTransportControls', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    withLocalVolume(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('transport', () => {
    it('wires each button to its playback action', async () => {
      const wrapper = mountControls()
      const playback = usePlaybackStore()
      playback.queue = [makeSong('1'), makeSong('2')]
      playback.currentIndex = 0
      const spies = {
        shuffle: vi.spyOn(playback, 'toggleShuffle').mockImplementation(() => {}),
        previous: vi.spyOn(playback, 'playPrevious').mockResolvedValue(),
        play: vi.spyOn(playback, 'togglePlay').mockResolvedValue(),
        next: vi.spyOn(playback, 'playNext').mockResolvedValue(),
        repeat: vi.spyOn(playback, 'cycleRepeatMode').mockImplementation(() => {}),
      }
      await wrapper.vm.$nextTick()

      button(wrapper, 'mdi-shuffle').click()
      button(wrapper, 'mdi-skip-previous').click()
      button(wrapper, 'mdi-play').click()
      button(wrapper, 'mdi-skip-next').click()
      button(wrapper, 'mdi-repeat').click()

      expect(spies.shuffle).toHaveBeenCalledOnce()
      expect(spies.previous).toHaveBeenCalledOnce()
      expect(spies.play).toHaveBeenCalledOnce()
      expect(spies.next).toHaveBeenCalledOnce()
      expect(spies.repeat).toHaveBeenCalledOnce()
    })

    it('shows pause while playing, and repeat-once in repeat-one mode', async () => {
      const wrapper = mountControls()
      const playback = usePlaybackStore()
      playback.isPlaying = true
      playback.repeatMode = 'one'
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.mdi-pause').exists()).toBe(true)
      expect(wrapper.find('.mdi-repeat-once').exists()).toBe(true)
    })

    it('disables the transport with nothing to play, and enables it for a radio station too', async () => {
      const wrapper = mountControls()
      const playback = usePlaybackStore()

      expect(button(wrapper, 'mdi-play').disabled).toBe(true)
      expect(button(wrapper, 'mdi-skip-previous').disabled).toBe(true)

      // Radio has no queue at all — it still counts as playable.
      playback.radioStation = {
        id: 'r1',
        name: 'Some Radio',
        streamUrl: 'http://x',
        homePageUrl: null,
      }
      await wrapper.vm.$nextTick()

      expect(button(wrapper, 'mdi-play').disabled).toBe(false)
    })

    it('disables skip-next at the end of the queue', async () => {
      const wrapper = mountControls()
      const playback = usePlaybackStore()
      playback.queue = [makeSong('1')]
      playback.currentIndex = 0
      await wrapper.vm.$nextTick()

      expect(button(wrapper, 'mdi-play').disabled).toBe(false)
      expect(button(wrapper, 'mdi-skip-next').disabled).toBe(true)
    })
  })

  describe('seeking', () => {
    it('renders position and duration as m:ss', async () => {
      const wrapper = mountControls()
      const playback = usePlaybackStore()
      playback.localPosition = 65
      playback.duration = 605
      await wrapper.vm.$nextTick()

      expect(wrapper.findAll('.mobile-transport__time').map((t) => t.text())).toEqual([
        '1:05',
        '10:05',
      ])
    })

    it('follows the drag locally and only seeks once on release', async () => {
      const wrapper = mountControls()
      const playback = usePlaybackStore()
      playback.localPosition = 10
      const seekSpy = vi.spyOn(playback, 'seek').mockResolvedValue()
      const waveform = wrapper.getComponent({ name: 'SongWaveform' })

      await waveform.vm.$emit('update:modelValue', 90)
      expect(seekSpy).not.toHaveBeenCalled()
      // The preview position wins over the store's own while dragging.
      expect(wrapper.findAll('.mobile-transport__time')[0]!.text()).toBe('1:30')

      await waveform.vm.$emit('end', 90)
      await wrapper.vm.$nextTick()

      expect(seekSpy).toHaveBeenCalledWith(90)
      // Preview released — back to whatever the store reports.
      expect(wrapper.findAll('.mobile-transport__time')[0]!.text()).toBe('0:10')
    })

    it('is disabled without a track', async () => {
      const wrapper = mountControls()
      const playback = usePlaybackStore()
      expect(wrapper.getComponent({ name: 'SongWaveform' }).props('disabled')).toBe(true)

      playback.queue = [makeSong('1')]
      playback.currentIndex = 0
      await wrapper.vm.$nextTick()
      expect(wrapper.getComponent({ name: 'SongWaveform' }).props('disabled')).toBe(false)
    })

    it('passes the buffered position through, but not while casting', async () => {
      const wrapper = mountControls()
      const playback = usePlaybackStore()
      playback.queue = [makeSong('1')]
      playback.currentIndex = 0
      playback.bufferedPosition = 42
      await wrapper.vm.$nextTick()
      expect(wrapper.getComponent({ name: 'SongWaveform' }).props('buffered')).toBe(42)

      castTo('Living Room', 'sonos')
      await wrapper.vm.$nextTick()
      expect(wrapper.getComponent({ name: 'SongWaveform' }).props('buffered')).toBe(0)
    })

    it('swaps the bar for a live-elapsed readout while radio plays, which has nothing to seek within', async () => {
      const wrapper = mountControls()
      const playback = usePlaybackStore()
      playback.localPosition = 754 // 12:34
      playback.radioStation = {
        id: 'r1',
        name: 'Some Radio',
        streamUrl: 'http://x',
        homePageUrl: null,
      }
      await wrapper.vm.$nextTick()

      expect(wrapper.findComponent({ name: 'SongWaveform' }).exists()).toBe(false)
      expect(wrapper.text()).toContain('Live · 12:34')

      playback.radioStation = null
      await wrapper.vm.$nextTick()

      expect(wrapper.findComponent({ name: 'SongWaveform' }).exists()).toBe(true)
    })
  })

  describe('cast button', () => {
    it('opens the device picker, and marks itself connected while casting', async () => {
      const wrapper = mountControls()

      expect(wrapper.getComponent({ name: 'MobileDevicePicker' }).props('modelValue')).toBe(false)

      button(wrapper, 'mdi-cast').click()
      await wrapper.vm.$nextTick()

      expect(wrapper.getComponent({ name: 'MobileDevicePicker' }).props('modelValue')).toBe(true)

      castTo('Kitchen', 'sonos')
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.mdi-cast-connected').exists()).toBe(true)
    })
  })

  describe('volume (local playback)', () => {
    it('shows the local volume as a rounded percentage and sets it from the slider', async () => {
      const wrapper = mountControls()
      const playback = usePlaybackStore()
      const setVolumeSpy = vi.spyOn(playback, 'setVolume').mockImplementation(() => {})
      playback.volume = 0.42
      await wrapper.vm.$nextTick()

      expect(wrapper.get('.mobile-transport__volume-value').text()).toBe('42%')

      await wrapper.getComponent({ name: 'VSlider' }).vm.$emit('update:modelValue', 0.6)
      expect(setVolumeSpy).toHaveBeenCalledWith(0.6)
    })

    it('mutes to 0 and restores the previous volume on the second tap', async () => {
      const wrapper = mountControls()
      const playback = usePlaybackStore()
      const setVolumeSpy = vi.spyOn(playback, 'setVolume').mockImplementation(() => {})
      playback.volume = 0.6
      await wrapper.vm.$nextTick()

      button(wrapper, 'mdi-volume-high').click()
      expect(setVolumeSpy).toHaveBeenLastCalledWith(0)

      playback.volume = 0
      await wrapper.vm.$nextTick()
      button(wrapper, 'mdi-volume-mute').click()
      expect(setVolumeSpy).toHaveBeenLastCalledWith(0.6)
    })

    it('locks the local slider while casting — it would move nothing', async () => {
      const wrapper = mountControls()
      // Two targets, so this is the local slider rather than the
      // single-target device one below.
      useConnectStore().status = makeStatus({
        targets: [
          { name: 'Kitchen', type: 'sonos', volume_push: true },
          { name: 'Living Room', type: 'sonos', volume_push: true },
        ],
      })
      await wrapper.vm.$nextTick()

      expect(wrapper.getComponent({ name: 'VSlider' }).props('disabled')).toBe(true)
      expect(button(wrapper, 'mdi-volume-high').disabled).toBe(true)
    })
  })

  describe('volume this device cannot change', () => {
    it('offers no slider on a phone, where only the system buttons can change it', () => {
      // The element's volume is read-only there and the Web Audio graph
      // that could do it instead is deliberately absent, so a slider here
      // would move and change nothing.
      withLocalVolume(false)

      const wrapper = mountControls()

      expect(wrapper.find('.mdi-volume-high').exists()).toBe(false)
      expect(wrapper.findAllComponents({ name: 'VSlider' })).toHaveLength(0)
    })

    it('still offers the speaker slider on that same phone while casting', async () => {
      // That level is set on the device over the network, so nothing about
      // this device's own audio applies to it.
      withLocalVolume(false)
      castTo('Living Room', 'sonos', 30)

      const wrapper = mountControls()
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.mdi-volume-high').exists()).toBe(true)
    })
  })

  describe('volume (single cast target)', () => {
    // Chromecast has no push channel (connectStore.isVolumePushCapable()),
    // so this exercises the polling fallback specifically.
    it('fetches and polls the device volume, and stops polling on unmount', async () => {
      vi.useFakeTimers()
      const wrapper = mountControls()
      const connect = useConnectStore()
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      castTo('Living Room', 'chromecast')
      await wrapper.vm.$nextTick()
      await vi.runOnlyPendingTimersAsync()

      expect(getVolumeSpy).toHaveBeenCalledWith('chromecast', 'Living Room')
      expect(wrapper.get('.mobile-transport__volume-value').text()).toBe('30%')

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
    it('fetches once for a push-capable target, then takes further readings from the pushed status', async () => {
      vi.useFakeTimers()
      const wrapper = mountControls()
      const connect = useConnectStore()
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      castTo('Kitchen', 'sonos', 30)
      await wrapper.vm.$nextTick()
      await vi.runOnlyPendingTimersAsync()

      expect(getVolumeSpy).toHaveBeenCalledOnce()
      expect(wrapper.get('.mobile-transport__volume-value').text()).toBe('30%')

      getVolumeSpy.mockClear()
      await vi.advanceTimersByTimeAsync(8000)
      expect(getVolumeSpy).not.toHaveBeenCalled()

      castTo('Kitchen', 'sonos', 55)
      await wrapper.vm.$nextTick()
      expect(wrapper.get('.mobile-transport__volume-value').text()).toBe('55%')
      expect(getVolumeSpy).not.toHaveBeenCalled()
    })

    it('never asks an AirPlay target for a volume it has no endpoint for', async () => {
      vi.useFakeTimers()
      const wrapper = mountControls()
      const connect = useConnectStore()
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      castTo('Bedroom', 'airplay')
      await wrapper.vm.$nextTick()
      await vi.advanceTimersByTimeAsync(8000)

      expect(getVolumeSpy).not.toHaveBeenCalled()
      expect(wrapper.get('.mobile-transport__volume-value').text()).toBe('—')
    })

    it('drops the previous device reading the moment the target changes', async () => {
      const wrapper = mountControls()
      const connect = useConnectStore()
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      castTo('Kitchen', 'sonos', 30)
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      expect(wrapper.get('.mobile-transport__volume-value').text()).toBe('30%')

      // Nothing pushed for the new one yet: showing Kitchen's 30% under
      // Bedroom's name would be a plain lie.
      getVolumeSpy.mockResolvedValue(70)
      castTo('Bedroom', 'sonos')
      await wrapper.vm.$nextTick()
      expect(wrapper.get('.mobile-transport__volume-value').text()).toBe('—')
    })

    it('sets the rounded device volume from the slider, and shows it immediately', async () => {
      const wrapper = mountControls()
      const connect = useConnectStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      const setVolumeSpy = vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
      castTo('Kitchen', 'sonos')
      await wrapper.vm.$nextTick()

      await wrapper.getComponent({ name: 'VSlider' }).vm.$emit('update:modelValue', 42.6)

      expect(setVolumeSpy).toHaveBeenCalledWith('sonos', 'Kitchen', 43)
      expect(wrapper.get('.mobile-transport__volume-value').text()).toBe('43%')
    })

    it('mutes/unmutes the device instead of the local player', async () => {
      const wrapper = mountControls()
      const connect = useConnectStore()
      const playback = usePlaybackStore()
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(60)
      const setDeviceVolumeSpy = vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
      const setLocalVolumeSpy = vi.spyOn(playback, 'setVolume').mockImplementation(() => {})
      castTo('Kitchen', 'sonos')
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()

      button(wrapper, 'mdi-volume-high').click()
      await wrapper.vm.$nextTick()
      expect(setDeviceVolumeSpy).toHaveBeenLastCalledWith('sonos', 'Kitchen', 0)

      button(wrapper, 'mdi-volume-mute').click()
      expect(setDeviceVolumeSpy).toHaveBeenLastCalledWith('sonos', 'Kitchen', 60)
      expect(setLocalVolumeSpy).not.toHaveBeenCalled()
    })
  })
})
