// The column picker itself: opened from the headings, writing to the one
// app-wide selection. Menus render into an overlay outside the component's
// own tree, so the assertions read the document.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useSongColumnsStore } from '@/stores/songColumns'
import { useAuthStore } from '@/stores/auth'
import { OPTIONAL_SONG_COLUMNS, resolveSongColumns } from '@/services/library/songColumns'
import SongTableHeader from '../SongTableHeader.vue'

const vuetify = createVuetify({ components, directives })

function mountHeader(props: Record<string, unknown> = {}) {
  return mount(SongTableHeader, {
    props: { columns: resolveSongColumns(['album']), ...props },
    attachTo: document.body,
    global: { plugins: [vuetify, i18n] },
  })
}

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll('.v-overlay-container .v-list-item')] as HTMLElement[]
}

/** One column's entry in the open menu, by its translated label. */
function entryFor(labelKey: string): HTMLElement {
  const label = i18n.global.t(labelKey)
  const found = menuItems().find(
    (item) => item.querySelector('.v-list-item-title')?.textContent?.trim() === label,
  )
  if (!found) throw new Error(`no menu entry labelled ${label}`)
  return found
}

/** Whether a menu entry's own checkbox is ticked. */
function checked(entry: HTMLElement): boolean {
  return entry.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? false
}

describe('the song table column menu', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('offers every optional column, ticking the ones already shown', async () => {
    const store = useSongColumnsStore()
    store.setColumns(['album'])
    const wrapper = mountHeader()

    await wrapper.get('.column-menu-button').trigger('click')

    // Every optional column plus the "reset" entry at the bottom.
    expect(menuItems()).toHaveLength(OPTIONAL_SONG_COLUMNS.length + 1)
    expect(checked(entryFor('library.album'))).toBe(true)
    expect(checked(entryFor('songInfo.bpm'))).toBe(false)
  })

  it('switches a column on without closing itself', async () => {
    const store = useSongColumnsStore()
    store.setColumns([])
    const wrapper = mountHeader()
    await wrapper.get('.column-menu-button').trigger('click')

    entryFor('songInfo.bpm').click()
    await wrapper.vm.$nextTick()

    expect(store.columns).toEqual(['bpm'])
    // Picking three columns should take one opening of the menu, not
    // three - see TileContextMenu's closeOnContentClick.
    expect(menuItems().length).toBeGreaterThan(0)
  })

  it('switches a shown column back off', async () => {
    const store = useSongColumnsStore()
    store.setColumns(['album', 'bpm'])
    const wrapper = mountHeader()
    await wrapper.get('.column-menu-button').trigger('click')

    entryFor('library.album').click()
    await wrapper.vm.$nextTick()

    expect(store.columns).toEqual(['bpm'])
  })

  it('opens on a right-click anywhere along the heading row', async () => {
    const wrapper = mountHeader()

    await wrapper.trigger('contextmenu', { clientX: 100, clientY: 40 })

    expect(menuItems().length).toBeGreaterThan(0)
  })

  it('puts the whole default set back', async () => {
    const store = useSongColumnsStore()
    store.setColumns(['path'])
    const wrapper = mountHeader()
    await wrapper.get('.column-menu-button').trigger('click')

    entryFor('library.resetColumns').click()
    await wrapper.vm.$nextTick()

    expect(store.columns).toContain('album')
    expect(store.columns).not.toContain('path')
  })

  it('greys out what this server cannot fill, and says why', async () => {
    useAuthStore().serverType = 'jellyfin'
    const wrapper = mountHeader()
    await wrapper.get('.column-menu-button').trigger('click')

    const bpm = entryFor('songInfo.bpm')
    expect(bpm.classList.contains('v-list-item--disabled')).toBe(true)
    expect(bpm.textContent).toContain(i18n.global.t('library.columnNotReported'))
    // A column Jellyfin does report is untouched.
    expect(entryFor('library.album').classList.contains('v-list-item--disabled')).toBe(false)
  })

  it('is not offered at all on a table whose columns the page fixed', () => {
    const wrapper = mountHeader({ configurable: false })

    expect(wrapper.find('.column-menu-button').exists()).toBe(false)
  })
})
