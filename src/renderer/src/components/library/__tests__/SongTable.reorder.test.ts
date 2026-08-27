import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import SongTable from '../SongTable.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

// jsdom lays nothing out: every getBoundingClientRect() is all zeros, so a
// row's vertical midpoint is always 0. A positive clientY therefore reads
// as the bottom half of a row and 0 as the top half — not real geometry,
// but a deterministic way to drive both branches (same stand-in
// QueueDrawer's own drag tests use).
const TOP_HALF = { clientY: 0 }
const BOTTOM_HALF = { clientY: 1 }

function mountTable(props: Record<string, unknown> = {}) {
  return mount(SongTable, {
    props: {
      songs: [makeSong('a'), makeSong('b'), makeSong('c'), makeSong('d')],
      defaultSortKey: null,
      reorderable: true,
      ...props,
    },
    global: {
      plugins: [vuetify, i18n],
      // SongRow subscribes to it on mount (closing other rows' context
      // menus) — main.ts installs it as a global property, which a test
      // mount has to stand in for itself.
      mocks: { $emitter: emitter },
    },
  })
}

describe('SongTable drag to reorder', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('makes rows draggable only when the list can actually be reordered', () => {
    expect(mountTable().get('.song-row').attributes('draggable')).toBe('true')
    expect(mountTable({ reorderable: false }).get('.song-row').attributes('draggable')).toBe(
      'false',
    )
  })

  it('reports a drop on the top half of a row as landing before it', async () => {
    const wrapper = mountTable()
    const rows = wrapper.findAll('.song-row')

    // 'd' (index 3) onto the top half of 'b' (index 1) — lands before 'b'.
    await rows[3]!.trigger('dragstart')
    await rows[1]!.trigger('dragover', TOP_HALF)
    await rows[1]!.trigger('drop', TOP_HALF)

    expect(wrapper.emitted('reorder')).toEqual([[{ from: 3, to: 1 }]])
  })

  it('shifts a drop below the dragged row by one, for its own removal', async () => {
    const wrapper = mountTable()
    const rows = wrapper.findAll('.song-row')

    // 'b' (index 1) onto the bottom half of 'd' (index 3): inserting after
    // 'd' is index 4 in the original list, but 3 once 'b' itself is gone.
    await rows[1]!.trigger('dragstart')
    await rows[3]!.trigger('dragover', BOTTOM_HALF)
    await rows[3]!.trigger('drop', BOTTOM_HALF)

    expect(wrapper.emitted('reorder')).toEqual([[{ from: 1, to: 3 }]])
  })

  it('says nothing when a row is dropped back where it started', async () => {
    const wrapper = mountTable()
    const rows = wrapper.findAll('.song-row')

    await rows[1]!.trigger('dragstart')
    await rows[1]!.trigger('drop', TOP_HALF)

    expect(wrapper.emitted('reorder')).toBeUndefined()
  })

  it('marks the row being dragged and the boundary it would land on', async () => {
    const wrapper = mountTable()
    const rows = wrapper.findAll('.song-row')

    await rows[0]!.trigger('dragstart')
    await rows[2]!.trigger('dragover', BOTTOM_HALF)

    expect(wrapper.findAll('.song-row')[0]!.classes()).toContain('song-row--dragging')
    expect(wrapper.findAll('.song-row')[2]!.classes()).toContain('song-row--drag-over-after')
  })

  it('clears the drag state when a drag is abandoned', async () => {
    const wrapper = mountTable()
    const rows = wrapper.findAll('.song-row')

    await rows[0]!.trigger('dragstart')
    await rows[2]!.trigger('dragover', TOP_HALF)
    await rows[0]!.trigger('dragend')

    const classes = wrapper.findAll('.song-row').flatMap((row) => row.classes())
    expect(classes).not.toContain('song-row--dragging')
    expect(classes).not.toContain('song-row--drag-over-before')
  })

  it('stops offering the drag while a column sort is active', async () => {
    // The rows on screen would no longer be the playlist's own order, so
    // "drop it here" couldn't mean anything.
    const wrapper = mountTable()
    const vm = wrapper.vm as unknown as { onSort(key: string): void }

    vm.onSort('title')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.song-row').attributes('draggable')).toBe('false')
  })

  it('gives a reorderable list a third sort click that clears the sort again', async () => {
    // Otherwise sorting a playlist once would take drag-to-reorder away
    // until the page is reloaded.
    const wrapper = mountTable()
    const vm = wrapper.vm as unknown as { onSort(key: string): void; sortKey: string | null }

    vm.onSort('title') // asc
    vm.onSort('title') // desc
    vm.onSort('title') // back to the playlist's own order
    await wrapper.vm.$nextTick()

    expect(vm.sortKey).toBeNull()
    expect(wrapper.get('.song-row').attributes('draggable')).toBe('true')
  })

  it('keeps toggling asc/desc for a list that has no order of its own', async () => {
    const wrapper = mountTable({ reorderable: false })
    const vm = wrapper.vm as unknown as {
      onSort(key: string): void
      sortKey: string | null
      sortDirection: string
    }

    vm.onSort('title')
    vm.onSort('title')
    vm.onSort('title')

    // Third click is back to ascending, not "no sort" — "unsorted" here is
    // just whatever the API happened to return, nothing worth offering.
    expect(vm.sortKey).toBe('title')
    expect(vm.sortDirection).toBe('asc')
  })
})
