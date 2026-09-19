import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
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
})
