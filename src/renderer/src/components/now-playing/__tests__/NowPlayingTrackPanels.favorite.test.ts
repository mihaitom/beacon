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

function song(id: string, starred = false): NowPlayingSong {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    artistId: 'ar',
    albumId: 'al',
    coverArtId: null,
    coverUrl: null,
    starred,
  }
}

function panel(s: NowPlayingSong): NowPlayingPanel {
  return { key: s.id, kind: 'song', song: s, eyebrow: '', title: s.title, radioTag: null }
}

function mountPanels({
  favorite = true,
  compact = true,
  landscape = false,
  panels = [panel(song('a'))],
} = {}) {
  const source = reactive({
    song: panels[0]!.song,
    panels,
    capabilities: { favorite, artistLinks: false },
    cover: { template: '<div />' },
    ui: { artworkHidden: false },
    toggleFavorite: vi.fn(),
  })
  const wrapper = mount(NowPlayingTrackPanels, {
    props: { compact, landscape },
    global: { plugins: [vuetify, i18n], provide: { [nowPlayingSourceKey]: source } },
  })
  return { wrapper, source }
}

describe("Now Playing's heart", () => {
  it('favourites the song that is playing', async () => {
    const { wrapper, source } = mountPanels()

    await wrapper.get('.now-playing__favorite').trigger('click')

    expect(source.toggleFavorite).toHaveBeenCalledOnce()
  })

  it('shows a favourite as one', () => {
    const { wrapper } = mountPanels({ panels: [panel(song('a', true))] })
    expect(wrapper.find('.now-playing__favorite .mdi-heart').exists()).toBe(true)
  })

  /** Near the end of a track the next song is announced beside it; a
   * heart there would favourite a song that is not playing. */
  it('is on the playing song only, not on the one announced next', () => {
    const { wrapper } = mountPanels({ panels: [panel(song('a')), panel(song('b'))] })
    expect(wrapper.findAll('.now-playing__favorite')).toHaveLength(1)
  })

  it('is left out where the host offers none (a party guest) and on the desktop', () => {
    expect(mountPanels({ favorite: false }).wrapper.find('.now-playing__favorite').exists()).toBe(
      false,
    )
    expect(mountPanels({ compact: false }).wrapper.find('.now-playing__favorite').exists()).toBe(
      false,
    )
  })

  /** Sideways is the car mount: a tap meant for the controls beside it
   * should not change the library. */
  it('is left out on a phone held sideways', () => {
    expect(mountPanels({ landscape: true }).wrapper.find('.now-playing__favorite').exists()).toBe(
      false,
    )
  })
})
