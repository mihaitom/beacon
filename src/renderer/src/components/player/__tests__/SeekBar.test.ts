import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
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
})
