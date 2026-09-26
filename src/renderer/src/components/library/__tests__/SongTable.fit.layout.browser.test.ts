// Real-browser test for a table narrower than its chosen columns - run via
// `pnpm test:layout`. It needs a real ResizeObserver and real flex layout:
// jsdom reports every width as 0, which is exactly the "not measured yet"
// case that keeps every column.
//
// The reported bug: twelve columns on an iPad Air (1180px) ran the rows
// ~400px past the table, which made the page wider than the screen - zoomed
// out on one load, cut off on the next.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import '@/assets/base.css'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useSongColumnsStore } from '@/stores/songColumns'
import SongTable from '../SongTable.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

async function mountTable(frameWidth: number, { settle = true } = {}) {
  await page.viewport(1400, 800)
  const frame = document.createElement('div')
  frame.style.width = `${frameWidth}px`
  document.body.appendChild(frame)
  const wrapper = mount(SongTable, {
    props: {
      songs: Array.from({ length: 5 }, (_, i) => makeSong(String(i), { title: `Song ${i}` })),
      defaultSortKey: null,
    },
    attachTo: frame,
    global: { plugins: [vuetify, i18n], mocks: { $emitter: emitter } },
  })
  wrappers.push(wrapper)
  // One ResizeObserver callback, then the re-render it causes.
  if (settle) await new Promise((resolve) => setTimeout(resolve, 100))
  else await nextTick()
  return wrapper.element as HTMLElement
}

describe('SongTable on a narrow screen', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    useSongColumnsStore().setColumns([
      'cover',
      'album',
      'genre',
      'year',
      'added',
      'lastPlayed',
      'playCount',
      'format',
    ])
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('keeps every row inside the table instead of widening the page', async () => {
    const table = await mountTable(900)
    const tableRight = table.getBoundingClientRect().right

    for (const row of table.querySelectorAll<HTMLElement>('.song-row, .song-table-header')) {
      const lastCell = [...row.querySelectorAll<HTMLElement>('[data-column]')].at(-1)!
      expect(lastCell.getBoundingClientRect().right).toBeLessThanOrEqual(tableRight + 1)
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
  })

  it('still offers the heart and menu once columns have given way', async () => {
    const table = await mountTable(900)

    expect(table.querySelector('.song-row [data-column="actions"]')).not.toBeNull()
    expect(table.querySelector('.song-row [data-column="lastPlayed"]')).toBeNull()
  })

  it('fits the columns before the first paint, not only once the observer reports', async () => {
    // A tablet's browser settles its zoom on the first frames; one frame of
    // the full-width row was enough to zoom the page out or cut it off.
    const table = await mountTable(900, { settle: false })

    expect(table.querySelector('.song-row [data-column="lastPlayed"]')).toBeNull()
  })

  it('draws every chosen column where there is room for them', async () => {
    const table = await mountTable(1380)

    expect(table.querySelector('.song-row [data-column="lastPlayed"]')).not.toBeNull()
  })
})
