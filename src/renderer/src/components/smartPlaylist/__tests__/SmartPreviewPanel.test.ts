import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Preview } from '@/services/navidrome/preview'
import SmartPreviewPanel from '../SmartPreviewPanel.vue'

const vuetify = createVuetify({ components, directives })

function mountPanel(preview: Preview) {
  return mount(SmartPreviewPanel, {
    props: { preview },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
  })
}

describe('SmartPreviewPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('plays only the clicked song, not the preview as a queue', async () => {
    const songs = [makeSong('a'), makeSong('b'), makeSong('c')]
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const wrapper = mountPanel({ songs, matched: 3, uncertain: 0, emptiedBy: null })

    await wrapper.findAll('.smart-preview__song button')[1]!.trigger('click')

    expect(play).toHaveBeenCalledTimes(1)
    expect(play.mock.calls[0]![0]).toEqual([songs[1]])
    expect(play.mock.calls[0]![1]).toBe(0)
  })
})
