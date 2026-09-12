// Removing rows from a playlist. What is worth testing here is not that
// the menu entry exists but that it names the *right* entries: the table
// works in view positions, the server works in playlist positions, and
// getting the translation between them wrong deletes somebody's music.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useLibraryStore } from '@/stores/library'
import SongTable from '../SongTable.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Song } from '@/types/library'

const vuetify = createVuetify({ components, directives })

const mounted: { unmount: () => void }[] = []

function mountTable(songs: Song[], props: Record<string, unknown> = {}) {
  const wrapper = mount(SongTable, {
    props: { songs, defaultSortKey: null, removable: true, ...props },
    attachTo: document.body,
    global: { plugins: [vuetify, i18n], mocks: { $emitter: emitter } },
  })
  mounted.push(wrapper)
  return wrapper
}

/** Opens a row's context menu and clicks "Remove from playlist". */
async function removeVia(wrapper: ReturnType<typeof mountTable>, rowIndex: number) {
  await wrapper.findAll('.song-row')[rowIndex]!.trigger('contextmenu', { clientX: 10, clientY: 10 })
  const entry = [...document.querySelectorAll('.v-list-item')].find((item) =>
    item.textContent?.includes(i18n.global.t('library.removeFromPlaylist')),
  )
  entry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wrapper.vm.$nextTick()
}

/** Picks a row via its checkbox, the way SongTable.select.test.ts does. */
async function pick(wrapper: ReturnType<typeof mountTable>, index: number) {
  const row = wrapper.findAll('.song-row')[index]!
  await row.trigger('mouseenter')
  await row.get('.song-select-checkbox input').trigger('click')
}

function lastRemoval(wrapper: ReturnType<typeof mountTable>) {
  const events = wrapper.emitted('remove')
  return events?.at(-1)?.[0] as { indexes: number[]; songs: Song[] } | undefined
}

describe('removing songs from a playlist', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Opening the row menu warms its playlist submenu, which unmocked is a
    // real request to a connect that isn't running.
    vi.spyOn(useLibraryStore(), 'fetchPlaylists').mockResolvedValue()
  })

  afterEach(() => {
    while (mounted.length) mounted.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('offers the entry only where a playlist is actually being shown', async () => {
    const songs = [makeSong('a'), makeSong('b')]
    const label = i18n.global.t('library.removeFromPlaylist')

    const plain = mountTable(songs, { removable: false })
    await plain.findAll('.song-row')[0]!.trigger('contextmenu', { clientX: 10, clientY: 10 })
    expect(document.body.textContent).not.toContain(label)

    const playlist = mountTable(songs)
    await playlist.findAll('.song-row')[0]!.trigger('contextmenu', { clientX: 10, clientY: 10 })
    expect(document.body.textContent).toContain(label)
  })

  it('reports the position within the playlist, not the row on screen', async () => {
    // Sorted by title, 'Song a' comes first — but it sits last in the
    // playlist itself, which is the position the server resolves against.
    const songs = [makeSong('c'), makeSong('b'), makeSong('a')]
    const wrapper = mountTable(songs, { defaultSortKey: 'title' })

    await removeVia(wrapper, 0)

    expect(lastRemoval(wrapper)?.songs.map((song) => song.id)).toEqual(['a'])
    expect(lastRemoval(wrapper)?.indexes).toEqual([2])
  })

  it('removes the copy that was clicked when a song appears twice', async () => {
    // Same song id in two entries — a lookup by id would always resolve to
    // the first one and quietly delete the wrong row.
    const twice = [makeSong('a'), makeSong('dup'), makeSong('b'), makeSong('dup')]
    const wrapper = mountTable(twice)

    await removeVia(wrapper, 3)

    expect(lastRemoval(wrapper)?.indexes).toEqual([3])
  })

  it('removes the whole selection, highest position first', async () => {
    const songs = [makeSong('a'), makeSong('b'), makeSong('c'), makeSong('d')]
    const wrapper = mountTable(songs)

    await pick(wrapper, 0)
    await pick(wrapper, 2)
    await removeVia(wrapper, 2)

    // Descending, so a server applying them one by one can't have an
    // earlier removal shift a later position.
    expect(lastRemoval(wrapper)?.indexes).toEqual([2, 0])
    expect(lastRemoval(wrapper)?.songs.map((song) => song.id)).toEqual(['a', 'c'])
  })

  it('drops a row it can no longer place from the request and the count alike', async () => {
    // A selected song that is not in `songs` any more (the list was
    // replaced under the menu) has no position to send. It has to leave
    // the message's count with it, or the toast claims more was removed
    // than was ever asked for.
    const songs = [makeSong('a'), makeSong('b')]
    const wrapper = mountTable(songs)
    const vm = wrapper.vm as unknown as {
      selectedOrSingle(song: Song, index?: number): Song[]
      onRemoveRequested(payload: { song: Song; index?: number }): void
    }
    vi.spyOn(vm, 'selectedOrSingle').mockReturnValue([songs[0]!, makeSong('gone')])

    vm.onRemoveRequested({ song: songs[0]!, index: 0 })

    expect(lastRemoval(wrapper)?.indexes).toEqual([0])
    expect(lastRemoval(wrapper)?.songs.map((song) => song.id)).toEqual(['a'])
  })

  it('acts on just the clicked row when it is not part of the selection', async () => {
    const songs = [makeSong('a'), makeSong('b'), makeSong('c')]
    const wrapper = mountTable(songs)

    await pick(wrapper, 0)
    await removeVia(wrapper, 2)

    expect(lastRemoval(wrapper)?.indexes).toEqual([2])
  })
})
