import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import RadioLiveStatus from '../RadioLiveStatus.vue'

const vuetify = createVuetify({ components, directives })

function mountStatus() {
  return mount(RadioLiveStatus, { global: { plugins: [vuetify, i18n] } })
}

function playRadio() {
  const playback = usePlaybackStore()
  playback.radioStation = {
    id: 'r1',
    name: 'Some Radio',
    streamUrl: 'http://station/stream',
    homePageUrl: null,
  }
  playback.isPlaying = true
  return playback
}

describe('RadioLiveStatus', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows the elapsed time as m:ss beside the live label', async () => {
    const wrapper = mountStatus()
    playRadio().localPosition = 65
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.radio-live__label').text()).toBe('Live')
    expect(wrapper.get('.radio-live__time').text()).toBe('1:05')
  })

  // A station is the only thing in the app that plays long enough to pass
  // an hour; the readout used to keep counting minutes ("76:47").
  it('switches to h:mm:ss once the station has been on for an hour', async () => {
    const wrapper = mountStatus()
    const playback = playRadio()
    playback.localPosition = 4607
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.radio-live__time').text()).toBe('1:16:47')

    // Exactly on the hour, and the minutes stay padded either side of it.
    playback.localPosition = 3600
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.radio-live__time').text()).toBe('1:00:00')

    // Just below it the shorter label is kept - no leading "0:".
    playback.localPosition = 3599
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.radio-live__time').text()).toBe('59:59')
  })

  // One sentence for a screen reader instead of the four fragments the
  // visible row is built from, which are hidden from it.
  it('carries the whole readout as one accessible label', async () => {
    const wrapper = mountStatus()
    playRadio().localPosition = 65
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.radio-live__sr').text()).toBe('Live · 1:05')
    expect(wrapper.get('.radio-live__readout').attributes('aria-hidden')).toBe('true')
  })

  // The one state on this row that offers an action. Before it existed a
  // station that went quiet left the player bar with nothing on it that
  // could bring the station back.
  it('offers a reconnect once the connection is lost', async () => {
    const wrapper = mountStatus()
    const playback = playRadio()
    playback.radioConnectionLost = true
    const reconnect = vi.spyOn(playback, 'reconnectRadio').mockImplementation(() => {})
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.radio-live__readout').exists()).toBe(false)
    await wrapper.get('.radio-live__retry').trigger('click')

    expect(reconnect).toHaveBeenCalledOnce()
  })

  // Both can be true for a moment - reconnectRadio() sets buffering on its
  // way out of the lost state - and "we are trying again" is the newer,
  // more useful of the two to show.
  it('shows the reconnect attempt rather than the lost state once one is under way', async () => {
    const wrapper = mountStatus()
    const playback = playRadio()
    playback.radioConnectionLost = false
    playback.radioBuffering = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.radio-live__retry').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'VProgressLinear' }).exists()).toBe(true)
  })

  // The elapsed time is frozen or misleading while this is true, so the
  // whole readout goes rather than showing a number that isn't moving.
  it('swaps the readout for an indeterminate bar while buffering', async () => {
    const wrapper = mountStatus()
    const playback = playRadio()
    playback.radioBuffering = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.radio-live__readout').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'VProgressLinear' }).exists()).toBe(true)
  })

  // A blinking "on air" over silence would be the one thing on this row
  // that isn't true.
  it('only pulses the dot while sound is actually playing', async () => {
    const wrapper = mountStatus()
    const playback = playRadio()
    playback.localPosition = 65
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.radio-live__dot').classes()).toContain('radio-live__dot--on-air')

    playback.isPlaying = false
    await wrapper.vm.$nextTick()

    // The dot stays — paused radio still shows how long it has been on,
    // just not as something currently on air.
    expect(wrapper.find('.radio-live__dot').exists()).toBe(true)
    expect(wrapper.get('.radio-live__dot').classes()).not.toContain('radio-live__dot--on-air')
    expect(wrapper.get('.radio-live__readout').classes()).toContain('radio-live__readout--off-air')
    expect(wrapper.get('.radio-live__time').text()).toBe('1:05')
  })

  /** A station restored from the last session is selected, not playing,
   * and has nothing behind it — "Live" there is a claim about something
   * that has not happened. Reported live 2026-09-05. */
  it('says nothing at all for a station that has not played yet', async () => {
    const wrapper = mountStatus()
    const playback = playRadio()
    playback.isPlaying = false
    playback.localPosition = 0
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.radio-live__readout').exists()).toBe(false)
    expect(wrapper.find('.radio-live__sr').exists()).toBe(false)
    // The row itself stays, so nothing shifts once it does start.
    expect(wrapper.find('.radio-live').exists()).toBe(true)
  })

  it('appears as soon as that station is started', async () => {
    const wrapper = mountStatus()
    const playback = playRadio()
    playback.isPlaying = false
    playback.localPosition = 0
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.radio-live__readout').exists()).toBe(false)

    playback.isPlaying = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.radio-live__readout').exists()).toBe(true)
  })
})
