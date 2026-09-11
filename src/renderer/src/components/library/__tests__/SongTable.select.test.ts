// Building a multi-song selection. A click per row is fine for two songs
// and absurd for forty, so the two things every list of this kind does -
// shift for a range, Ctrl/Cmd+A for all of it - are what this covers.
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

const vuetify = createVuetify({ components, directives })

// Every table listens on `window` for as long as it is mounted, so one left
// standing answers the next test's Ctrl+A as well - which is exactly how
// the "leaves Ctrl+A alone" case first went red.
const mounted: { unmount: () => void }[] = []

function mountTable(count = 6) {
  const wrapper = mount(SongTable, {
    props: {
      songs: Array.from({ length: count }, (_unused, index) => makeSong(`s${index}`)),
      defaultSortKey: null,
    },
    attachTo: document.body,
    global: { plugins: [vuetify, i18n], mocks: { $emitter: emitter } },
  })
  mounted.push(wrapper)
  return wrapper
}

/** The selection, as row positions, straight off the component. */
function selected(wrapper: ReturnType<typeof mountTable>): number[] {
  return [...(wrapper.vm as unknown as { selectedRowKeys: Set<number> }).selectedRowKeys].sort(
    (a, b) => a - b,
  )
}

/** Picks a row the way the reader does: the checkbox, which only exists
 * once the row is hovered or a selection is already running. */
async function pick(
  wrapper: ReturnType<typeof mountTable>,
  index: number,
  modifiers: { shiftKey?: boolean } = {},
) {
  const row = wrapper.findAll('.song-row')[index]!
  await row.trigger('mouseenter')
  await row.get('.song-select-checkbox input').trigger('click', modifiers)
}

describe('selecting songs in a table', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Starting a selection warms the row menu's playlist submenu (see
    // ensurePlaylistsForSelection) - which, unmocked, is a real request to
    // a connect that isn't running.
    vi.spyOn(useLibraryStore(), 'fetchPlaylists').mockResolvedValue()
  })

  afterEach(() => {
    while (mounted.length) mounted.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('selects a range from the last picked row when shift is held', async () => {
    const wrapper = mountTable()

    await pick(wrapper, 1)
    await pick(wrapper, 4, { shiftKey: true })

    expect(selected(wrapper)).toEqual([1, 2, 3, 4])
  })

  it('extends a range backwards just as well', async () => {
    const wrapper = mountTable()

    await pick(wrapper, 4)
    await pick(wrapper, 2, { shiftKey: true })

    expect(selected(wrapper)).toEqual([2, 3, 4])
  })

  it('adds to the selection rather than replacing what a range already held', async () => {
    const wrapper = mountTable()

    await pick(wrapper, 0)
    await pick(wrapper, 1, { shiftKey: true })
    // A second range from the row picked last, which is now row 1.
    await pick(wrapper, 3, { shiftKey: true })

    expect(selected(wrapper)).toEqual([0, 1, 2, 3])
  })

  it('is a plain toggle without shift, and with nothing to anchor to', async () => {
    const wrapper = mountTable()

    // Shift on the very first pick has no anchor to measure from.
    await pick(wrapper, 2, { shiftKey: true })
    expect(selected(wrapper)).toEqual([2])

    await pick(wrapper, 2)
    expect(selected(wrapper)).toEqual([])
  })

  it('grows the selection to the whole list on Ctrl+A', async () => {
    const wrapper = mountTable()
    await pick(wrapper, 0)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
    await wrapper.vm.$nextTick()

    expect(selected(wrapper)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('leaves Ctrl+A alone while nothing is selected', async () => {
    // A window-level listener on a page that can hold more than one table:
    // taking the browser's own select-everything before the reader has
    // shown any interest in selecting rows would be taking a key that is
    // not ours.
    const wrapper = mountTable()
    const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true })

    window.dispatchEvent(event)
    await wrapper.vm.$nextTick()

    expect(selected(wrapper)).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  it('takes the whole list, and gives it back, from the heading checkbox', async () => {
    // The way out of a selection that isn't a keyboard shortcut: Escape and
    // a second Ctrl+A were the only ones, and neither is visible.
    const wrapper = mountTable()
    const header = wrapper.get('.song-table-header')

    await header.trigger('mouseenter')
    await header.get('.select-all-checkbox input').trigger('click')
    expect(selected(wrapper)).toEqual([0, 1, 2, 3, 4, 5])

    await header.get('.select-all-checkbox input').trigger('click')
    expect(selected(wrapper)).toEqual([])
  })

  it('grows a part-way selection to the whole list before it clears it', async () => {
    const wrapper = mountTable()
    await pick(wrapper, 2)

    // Visible without hovering the heading row at all, since a selection is
    // already running.
    await wrapper.get('.song-table-header .select-all-checkbox input').trigger('click')
    expect(selected(wrapper)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('keeps the heading checkbox out of the way while nothing is selected', () => {
    const wrapper = mountTable()

    expect(wrapper.find('.select-all-checkbox').exists()).toBe(false)
  })

  it('drops the anchor with the selection, so a later range cannot span the old list', async () => {
    const wrapper = mountTable()
    await pick(wrapper, 1)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(selected(wrapper)).toEqual([])

    // Shift again: with the anchor gone this is a plain pick, not a range
    // back to row 1.
    await pick(wrapper, 4, { shiftKey: true })
    expect(selected(wrapper)).toEqual([4])
  })
})
