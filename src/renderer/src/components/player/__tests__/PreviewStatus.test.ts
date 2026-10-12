import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { makeSong } from '@/stores/__tests__/fixtures'
import PreviewStatus from '../PreviewStatus.vue'

const vuetify = createVuetify({ components, directives })

function mountStatus() {
  return mount(PreviewStatus, { global: { plugins: [vuetify, i18n] } })
}

describe('PreviewStatus', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('is not there without a preview', () => {
    expect(mountStatus().find('button').exists()).toBe(false)
  })

  it('offers to play from the previewed song', async () => {
    const playback = usePlaybackStore()
    playback.preview = {
      songs: [makeSong('a'), makeSong('b')],
      picks: [0, 1],
      index: 1,
      resumeAt: 0,
      whole: true,
    }
    const play = vi.spyOn(playback, 'playFromPreview').mockResolvedValue()
    const wrapper = mountStatus()
    expect(wrapper.text()).toContain('2/2')
    await wrapper.get('button').trigger('click')
    expect(play).toHaveBeenCalled()
  })

  it('has nothing to play from for a preview another client started', () => {
    usePlaybackStore().preview = {
      songs: [makeSong('a')],
      picks: [0],
      index: 0,
      resumeAt: 0,
      whole: false,
    }
    const wrapper = mountStatus()
    expect(wrapper.text()).toContain('1/1')
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
