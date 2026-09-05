// What a double-click on a row actually puts in the queue. The rule is one
// prop (`queueWholeList`), and which value a given view passes is a real
// decision - see the prop's own comment - so both branches are pinned here
// rather than left to whichever view happens to be tested.
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

function mountTable(props: Record<string, unknown> = {}) {
  return mount(SongTable, {
    props: {
      songs: [makeSong('a'), makeSong('b'), makeSong('c')],
      // Natural order, so the row clicked below is the song expected -
      // the default sort is by title, which these fixtures share.
      defaultSortKey: null,
      ...props,
    },
    global: {
      plugins: [vuetify, i18n],
      // SongRow subscribes to it on mount (closing other rows' context
      // menus) - main.ts installs it as a global property, which a test
      // mount has to stand in for itself.
      mocks: { $emitter: emitter },
    },
  })
}

describe('playing a song from a table', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /** An album, an artist's tracks, a shelf on Home: a sequence somebody
   * meant, so it plays through from the row that was clicked. */
  it('queues the whole list from that row when the list is a sequence', async () => {
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const wrapper = mountTable()

    await wrapper.findAll('.song-row')[1]!.trigger('dblclick')

    const [songs, position] = play.mock.calls[0]!
    expect(songs.map((song) => song.id)).toEqual(['a', 'b', 'c'])
    expect(position).toBe(1)
  })

  /** Search results, a genre, the whole library: a list of matches. Playing
   * one of them must not drag the other matches into the queue behind it. */
  it('queues only the clicked song when the list is just matches', async () => {
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const wrapper = mountTable({ queueWholeList: false })

    await wrapper.findAll('.song-row')[1]!.trigger('dblclick')

    const [songs, position] = play.mock.calls[0]!
    expect(songs.map((song) => song.id)).toEqual(['b'])
    expect(position).toBe(0)
  })
})
