import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { makeSong } from '@/stores/__tests__/fixtures'
import SongCard from '../SongCard.vue'

const vuetify = createVuetify({ components, directives })

function mountCard(song = makeSong('s1', { title: 'Old Favorite' })) {
  return mount(SongCard, {
    props: { song },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true, RouterLink: true } },
  })
}

describe('SongCard', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('plays just this song when its cover is clicked', async () => {
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const song = makeSong('s1')
    const wrapper = mountCard(song)

    await wrapper.find('.song-card-cover').trigger('click')

    expect(play).toHaveBeenCalledWith([song], 0)
  })

  it('stars the song and shows it straight away', async () => {
    const toggle = vi.spyOn(useLibraryStore(), 'toggleStar').mockResolvedValue()
    const song = makeSong('s1', { starred: false })
    const wrapper = mountCard(song)

    await wrapper.find('.song-card-star').trigger('click')
    await flushPromises()

    expect(toggle).toHaveBeenCalledWith({ id: 's1', starred: false })
    expect(song.starred).toBe(true)
  })

  it('does not start the song when only the heart was clicked', async () => {
    vi.spyOn(useLibraryStore(), 'toggleStar').mockResolvedValue()
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const wrapper = mountCard()

    await wrapper.find('.song-card-star').trigger('click')

    expect(play).not.toHaveBeenCalled()
  })

  describe('as a line of a chart', () => {
    function mountRow(song = makeSong('s1')) {
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/:any(.*)', component: { template: '<div />' } }],
      })
      return mount(SongCard, {
        props: { song, row: true },
        global: { plugins: [vuetify, i18n, router], stubs: { CoverArt: true } },
      })
    }

    it('plays just this song wherever the line is clicked', async () => {
      const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
      const song = makeSong('s1')
      const wrapper = mountRow(song)

      await wrapper.find('.song-card-row__title').trigger('click')

      expect(play).toHaveBeenCalledWith([song], 0)
    })

    it('does not start the song when only the heart was clicked', async () => {
      vi.spyOn(useLibraryStore(), 'toggleStar').mockResolvedValue()
      const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
      const wrapper = mountRow()

      await wrapper.find('.song-card-row__star').trigger('click')

      expect(play).not.toHaveBeenCalled()
    })

    it('does not start the song when the artist is followed', async () => {
      const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
      const wrapper = mountRow()

      await wrapper.find('.song-card-artist a').trigger('click')

      expect(play).not.toHaveBeenCalled()
    })
  })
})
