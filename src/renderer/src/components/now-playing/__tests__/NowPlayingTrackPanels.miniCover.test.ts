import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import NowPlayingTrackPanels from '../NowPlayingTrackPanels.vue'
import { nowPlayingSourceKey, type NowPlayingPanel, type NowPlayingSong } from '../source'

const vuetify = createVuetify({ components, directives })

function song(id: string): NowPlayingSong {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    artistId: 'ar',
    albumId: 'al',
    coverArtId: null,
    coverUrl: null,
    starred: false,
  }
}

function panel(s: NowPlayingSong): NowPlayingPanel {
  return { key: s.id, kind: 'song', song: s, eyebrow: '', title: s.title, radioTag: null }
}

/** The desktop with the artwork hidden: the small cover in the corner. */
function mountCorner(panels = [panel(song('a'))]) {
  const source = reactive({
    song: panels[0]!.song,
    panels,
    capabilities: { favorite: false, artistLinks: false },
    cover: { template: '<div class="test-cover" />' },
    ui: { artworkHidden: true },
    toggleArtwork: vi.fn(),
  })
  const wrapper = mount(NowPlayingTrackPanels, {
    props: { compact: false },
    global: { plugins: [vuetify, i18n], provide: { [nowPlayingSourceKey]: source } },
  })
  return { wrapper, source }
}

describe("Now Playing's small cover", () => {
  it('brings the large artwork back when clicked', async () => {
    const { wrapper, source } = mountCorner()

    await wrapper.get('.now-playing__mini-art-button').trigger('click')

    expect(source.toggleArtwork).toHaveBeenCalledOnce()
  })

  /** Near the end of a track the next song is announced beside it; its
   * cover is not what the large artwork would show. */
  it("is a button on the playing song's cover only, not the one announced next", () => {
    const { wrapper } = mountCorner([panel(song('a')), panel(song('b'))])

    expect(wrapper.findAll('.test-cover')).toHaveLength(2)
    expect(wrapper.findAll('.now-playing__mini-art-button')).toHaveLength(1)
  })
})
