import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useConnectStore } from '@/stores/connect'
import SeekBar from '../SeekBar.vue'

const vuetify = createVuetify({ components, directives })

function mountSeekBar() {
  return mount(SeekBar, {
    global: { plugins: [vuetify, i18n], stubs: { SongWaveform: true } },
  })
}

describe('SeekBar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('formatTime', () => {
    it.each([
      [0, '0:00'],
      [5, '0:05'],
      [65, '1:05'],
      [3599, '59:59'],
      [-3, '0:00'],
    ])('formats %i seconds as %s', (seconds, expected) => {
      const wrapper = mountSeekBar()
      expect((wrapper.vm as unknown as { formatTime(s: number): string }).formatTime(seconds)).toBe(
        expected,
      )
    })
  })

  it('onSeekEnd seeks the playback store and clears the preview position', async () => {
    const wrapper = mountSeekBar()
    const playback = usePlaybackStore()
    const seekSpy = vi.spyOn(playback, 'seek').mockResolvedValue()

    const vm = wrapper.vm as unknown as {
      onSeekEnd(v: number): Promise<void>
      seekPreviewPosition: number | null
    }
    vm.seekPreviewPosition = 42
    await vm.onSeekEnd(90)

    expect(seekSpy).toHaveBeenCalledWith(90)
    expect(vm.seekPreviewPosition).toBeNull()
  })

  describe('bufferedPosition', () => {
    it('passes the store value through for ordinary local playback', () => {
      const wrapper = mountSeekBar()
      usePlaybackStore().bufferedPosition = 42

      expect((wrapper.vm as unknown as { bufferedPosition: number }).bufferedPosition).toBe(42)
    })

    it('reports 0 while casting, which buffers on the device itself', () => {
      const wrapper = mountSeekBar()
      usePlaybackStore().bufferedPosition = 42
      useConnectStore().status = { targets: [{ name: 'Living Room', type: 'sonos' }] } as never

      expect((wrapper.vm as unknown as { bufferedPosition: number }).bufferedPosition).toBe(0)
    })
  })

  describe('radio', () => {
    it('replaces the bar with an elapsed-time readout instead of a dead, maxed-out bar', async () => {
      const wrapper = mountSeekBar()
      const playback = usePlaybackStore()
      playback.localPosition = 754 // 12:34
      playback.radioStation = {
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
      } as never
      await wrapper.vm.$nextTick()

      expect(wrapper.find('song-waveform-stub').exists()).toBe(false)
      expect(wrapper.text()).toContain('Live · 12:34')
    })

    it('shows the bar again once radio stops', async () => {
      const wrapper = mountSeekBar()
      const playback = usePlaybackStore()
      playback.radioStation = {
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
      } as never
      await wrapper.vm.$nextTick()

      playback.radioStation = null
      await wrapper.vm.$nextTick()

      expect(wrapper.find('song-waveform-stub').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('Live')
    })
  })
})
