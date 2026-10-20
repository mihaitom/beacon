import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import NowPlayingArtwork from '../NowPlayingArtwork.vue'
import { nowPlayingSourceKey, type NowPlayingSong } from '../source'

const vuetify = createVuetify({ components, directives })

const song: NowPlayingSong = {
  id: 'a',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  artistId: 'ar',
  albumId: 'al',
  coverArtId: null,
  coverUrl: null,
  starred: false,
}

/** The large artwork, over an artist background or over the cover's own. */
function mountArtwork(isArtist: boolean) {
  const source = reactive({
    song,
    radio: null,
    glowColor: 'none',
    backdrop: { source: null, isArtist, backgrounds: [] },
    cover: { template: '<div class="test-cover" />' },
    toggleArtwork: vi.fn(),
  })
  const wrapper = mount(NowPlayingArtwork, {
    props: { artSize: '300px' },
    global: { plugins: [vuetify, i18n], provide: { [nowPlayingSourceKey]: source } },
  })
  return { wrapper, source }
}

describe("Now Playing's large artwork", () => {
  it('makes itself small when clicked over an artist background', async () => {
    const { wrapper, source } = mountArtwork(true)

    await wrapper.get('.now-playing__art-button').trigger('click')

    expect(source.toggleArtwork).toHaveBeenCalledOnce()
  })

  /** Without a background, hiding the artwork would leave nothing. */
  it('is not a button without an artist background', () => {
    const { wrapper } = mountArtwork(false)

    expect(wrapper.find('.test-cover').exists()).toBe(true)
    expect(wrapper.find('.now-playing__art-button').exists()).toBe(false)
  })
})
