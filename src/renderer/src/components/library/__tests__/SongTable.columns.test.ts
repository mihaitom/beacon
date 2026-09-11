// Which columns a table actually draws. The interesting part is that three
// separate things get a say - the user's selection, the page's own veto and
// (for Home's chart) a fixed override - and that the heading row and the
// data rows have to end up with exactly the same answer.
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useSongColumnsStore } from '@/stores/songColumns'
import { useAuthStore } from '@/stores/auth'
import SongTable from '../SongTable.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function mountTable(props: Record<string, unknown> = {}) {
  return mount(SongTable, {
    props: {
      songs: [makeSong('a', { bpm: 128, path: '/music/a.flac' })],
      defaultSortKey: null,
      ...props,
    },
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: emitter },
    },
  })
}

/** The column keys one element actually carries, in DOM order. */
function columnsOf(wrapper: ReturnType<typeof mountTable>, selector: string): string[] {
  return wrapper
    .get(selector)
    .findAll('[data-column]')
    .map((cell) => cell.attributes('data-column') as string)
}

describe('song table columns', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('draws the columns the user chose, headings and rows alike', async () => {
    useSongColumnsStore().setColumns(['bpm', 'album'])
    const wrapper = mountTable()
    await wrapper.vm.$nextTick()

    const expected = ['index', 'title', 'album', 'bpm', 'duration', 'actions']
    expect(columnsOf(wrapper, '.song-table-header')).toEqual(expected)
    // The header and the rows drift out of alignment the moment these two
    // disagree, which is the whole reason both read one array.
    expect(columnsOf(wrapper, '.song-row')).toEqual(expected)
  })

  it('shows the field in the cell, not just the column', async () => {
    useSongColumnsStore().setColumns(['bpm'])
    const wrapper = mountTable()
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.song-row [data-column="bpm"]').text()).toBe('128')
  })

  it("honours the page's veto over the user's selection", async () => {
    useSongColumnsStore().setColumns(['cover', 'album', 'genre'])
    const wrapper = mountTable({ excludeColumns: ['cover', 'album'] })
    await wrapper.vm.$nextTick()

    expect(columnsOf(wrapper, '.song-table-header')).toEqual([
      'index',
      'title',
      'genre',
      'duration',
      'actions',
    ])
  })

  it('leaves a fixed-column table alone and gives it no column menu', async () => {
    useSongColumnsStore().setColumns(['bpm', 'path'])
    const wrapper = mountTable({ columns: ['cover', 'playCount'] })
    await wrapper.vm.$nextTick()

    expect(columnsOf(wrapper, '.song-table-header')).toEqual([
      'index',
      'cover',
      'title',
      'playCount',
      'duration',
      'actions',
    ])
    expect(wrapper.find('.column-menu-button').exists()).toBe(false)
  })

  it('follows the selection changing under it', async () => {
    const store = useSongColumnsStore()
    store.setColumns(['album'])
    const wrapper = mountTable()
    await wrapper.vm.$nextTick()
    expect(columnsOf(wrapper, '.song-row')).toContain('album')

    store.toggle('album')
    await wrapper.vm.$nextTick()

    expect(columnsOf(wrapper, '.song-row')).not.toContain('album')
  })

  it('sorts by a column the registry knows how to sort', async () => {
    useSongColumnsStore().setColumns(['bpm'])
    const wrapper = mountTable({
      songs: [makeSong('slow', { bpm: 90 }), makeSong('fast', { bpm: 180 })],
    })
    await wrapper.vm.$nextTick()

    await wrapper.get('.song-table-header [data-column="bpm"] .sort-header').trigger('click')

    expect(wrapper.findAll('.song-row [data-column="bpm"]').map((cell) => cell.text())).toEqual([
      '90',
      '180',
    ])
  })

  it('leaves out a column this server has nothing to put in it', async () => {
    // The complaint this answers: on Jellyfin, BPM and the file's own
    // figures were a column of dashes on every row.
    useAuthStore().serverType = 'jellyfin'
    const store = useSongColumnsStore()
    store.setColumns(['bpm', 'album'])
    const wrapper = mountTable()
    await wrapper.vm.$nextTick()

    expect(columnsOf(wrapper, '.song-row')).toEqual([
      'index',
      'title',
      'album',
      'duration',
      'actions',
    ])
    // Still selected, so it is back on the next Navidrome login.
    expect(store.columns).toContain('bpm')
  })

  it('sizes the trailing cell for what this server actually puts in it', async () => {
    // Plex's core API has no favorite of its own (see
    // services/capabilities.ts), so the heart's 28px there was width the
    // title and album columns were being squeezed out of.
    const width = (wrapper: ReturnType<typeof mountTable>): string =>
      wrapper.get('.song-row [data-column="actions"]').attributes('style') ?? ''

    useAuthStore().serverType = 'subsonic'
    expect(width(mountTable())).toContain('80px')

    setActivePinia(createPinia())
    useAuthStore().serverType = 'plex'
    expect(width(mountTable())).toContain('52px')
  })

  it('switches the rating off like any other column', async () => {
    useAuthStore().serverType = 'subsonic'
    const store = useSongColumnsStore()
    store.setColumns(['rating'])
    const wrapper = mountTable()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.song-table-header [data-column="rating"] .sort-header').exists()).toBe(
      true,
    )

    store.toggle('rating')
    await wrapper.vm.$nextTick()

    // The whole column goes, not just the stars - which is the 112px this
    // was worth doing for.
    expect(columnsOf(wrapper, '.song-row')).not.toContain('rating')
  })

  it('does not offer a rating on a server that has no scale for one', async () => {
    // Jellyfin has only a boolean favorite. A rating column there was five
    // hollow stars on every row and a heading that sorted the list by
    // nothing.
    useAuthStore().serverType = 'jellyfin'
    useSongColumnsStore().setColumns(['rating'])
    const wrapper = mountTable()
    await wrapper.vm.$nextTick()

    expect(columnsOf(wrapper, '.song-row')).not.toContain('rating')
    // Still selected, so the stars are back on the next Navidrome login.
    expect(useSongColumnsStore().columns).toContain('rating')
  })

  it('keeps the skeleton row in the shape of the table it stands in for', async () => {
    useSongColumnsStore().setColumns(['cover', 'bpm'])
    const wrapper = mountTable({ loading: true })
    await wrapper.vm.$nextTick()

    // Six columns wide, same as the real rows will be - a skeleton of a
    // different width is a visible jump the moment the data lands.
    expect(wrapper.get('.song-row--skeleton').findAll('.skeleton-cell')).toHaveLength(6)
  })
})
