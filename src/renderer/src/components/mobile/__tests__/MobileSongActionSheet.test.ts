import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import { VListItem } from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import MobileSongActionSheet from '../MobileSongActionSheet.vue'

const vuetify = createVuetify({ components, directives })

// v-bottom-sheet teleports its content, so the items are found through the
// component tree rather than the wrapper's DOM - see MobileDevicePicker.test.ts.
function mountSheet(queueIndex: number) {
  const playback = usePlaybackStore()
  return mount(MobileSongActionSheet, {
    props: { modelValue: true, song: playback.queue[queueIndex], queueIndex },
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      stubs: { CoverArt: true },
      mocks: { $emitter: emitter, $router: { push: vi.fn() } },
    },
  })
}

function item(wrapper: ReturnType<typeof mountSheet>, label: string) {
  const found = wrapper.findAllComponents(VListItem).find((candidate) => candidate.text() === label)
  if (!found) throw new Error(`no "${label}" in the sheet`)
  return found
}

describe('MobileSongActionSheet on a queue row', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.spyOn(useLibraryStore(), 'fetchPlaylists').mockResolvedValue()
    usePlaybackStore().setQueue(
      ['a', 'b', 'c', 'd'].map((id) => makeSong(id)),
      0,
    )
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('favourites the song it was opened on, and offers to undo it', async () => {
    const library = useLibraryStore()
    const toggleFavorite = vi.spyOn(library, 'toggleFavorite').mockResolvedValue()
    const song = usePlaybackStore().queue[2]!

    await item(mountSheet(2), 'Add to favorites').trigger('click')
    expect(toggleFavorite).toHaveBeenCalledWith('song', song)

    song.starred = true
    expect(() => item(mountSheet(2), 'Remove from favorites')).not.toThrow()
  })

  it('moves the song it was opened on, not another one with its id', async () => {
    const playback = usePlaybackStore()
    const wrapper = mountSheet(3)

    await item(wrapper, 'Play next').trigger('click')

    expect(playback.queue.map((song) => song.id)).toEqual(['a', 'd', 'b', 'c'])
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('moves to the end, removes and plays by queue position', async () => {
    const playback = usePlaybackStore()
    const playAtIndex = vi.spyOn(playback, 'playAtIndex').mockResolvedValue()

    await item(mountSheet(1), 'Move to end').trigger('click')
    expect(playback.queue.map((song) => song.id)).toEqual(['a', 'c', 'd', 'b'])
    await item(mountSheet(1), 'Remove from queue').trigger('click')
    expect(playback.queue.map((song) => song.id)).toEqual(['a', 'd', 'b'])
    await item(mountSheet(2), 'Play').trigger('click')
    expect(playAtIndex).toHaveBeenCalledWith(2)
  })

  it('offers neither playing nor removing the song that is playing', async () => {
    const wrapper = mountSheet(0)
    await flushPromises()

    expect(item(wrapper, 'Play').props('disabled')).toBe(true)
    expect(item(wrapper, 'Remove from queue').props('disabled')).toBe(true)
    expect(item(wrapper, 'Move to end').props('disabled')).toBe(true)
  })

  it('opens the song info', async () => {
    const opened = vi.fn()
    emitter.on('showSongInfo', opened)
    await item(mountSheet(2), 'Info').trigger('click')
    emitter.off('showSongInfo', opened)

    expect(opened).toHaveBeenCalledWith(usePlaybackStore().queue[2])
  })
})
