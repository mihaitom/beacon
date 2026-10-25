// The grid form of the table (Songs' and a genre's grid/list toggle): the
// same list as the rows, in the same order, only as tiles.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { usePlaybackStore } from '@/stores/playback'
import SongTable from '../SongTable.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function mountGrid(props: Record<string, unknown> = {}) {
  return mount(SongTable, {
    props: {
      songs: [
        makeSong('b', { title: 'Beta', bpm: 128 }),
        makeSong('a', { title: 'Alpha', bpm: 92 }),
        makeSong('c', { title: 'Gamma', bpm: 95 }),
      ],
      grid: true,
      queueWholeList: false,
      ...props,
    },
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: emitter },
      stubs: { CoverArt: true },
    },
  })
}

function tileTitles(wrapper: ReturnType<typeof mountGrid>): string[] {
  return wrapper.findAll('.song-card').map((tile) => tile.find('.song-card-title').text())
}

describe('the song grid', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows the songs as tiles in the order picked', () => {
    const wrapper = mountGrid({ sort: { key: 'bpm', direction: 'asc' } })

    expect(wrapper.findAll('.song-row')).toHaveLength(0)
    expect(tileTitles(wrapper)).toEqual(['Alpha', 'Gamma', 'Beta'])
  })

  it('heads each section the way the list does', () => {
    const wrapper = mountGrid({ sort: { key: 'bpm', direction: 'asc' }, sectioned: true })

    const headings = wrapper.findAll('.letter-divider').map((divider) => divider.text())
    expect(headings).toHaveLength(2)
  })

  it('plays the song whose cover is clicked', async () => {
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const wrapper = mountGrid({ sort: { key: 'title', direction: 'asc' } })

    await wrapper.findAll('.song-card-cover')[1]!.trigger('click')

    expect(play.mock.calls[0]![0].map((song) => song.id)).toEqual(['b'])
  })
})
