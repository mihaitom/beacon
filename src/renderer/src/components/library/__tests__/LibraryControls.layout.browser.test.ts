// Real-browser test for a library page's filter row (Songs, Albums,
// Artists, a genre) - run via `pnpm test:layout`. What wraps where, and how
// wide the sort select is, is flex and grid layout, which jsdom does not
// compute at all.
//
// The layout toggle, the filter menu and the order (.library-controls in
// assets/base.css) move as one: a row too narrow for the search and all
// three puts the group on a line of its own instead of leaving the order
// alone on a second line. The sort select is as wide as its longest order,
// and in a window too narrow for that it is the one that gives.
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@/assets/main.css'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import LibrarySortSelect from '../LibrarySortSelect.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

const SHORT = { title: 'Title', value: 'title' }
const LONG = { title: 'Number of albums by this artist', value: 'long' }

interface Row {
  search: HTMLElement
  /** The toggle, the filter button and the sort select. */
  pills: HTMLElement[]
  sortName: () => HTMLElement
}

/** The row as a page lays it out: the search, then the toggle and the
 * filter button at their real widths and the real sort select. */
async function mountRow(width: number, picked = SHORT.value): Promise<Row> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const box = (className: string, boxWidth: number) =>
    h('div', { class: className, style: { width: `${boxWidth}px`, height: '40px' } })
  const wrapper = mount(
    {
      render: () =>
        h('div', { class: 'library-filter', style: { width: `${width}px` } }, [
          box('search', 320),
          h('div', { class: 'library-controls' }, [
            box('pill', 88),
            box('pill', 100),
            h(LibrarySortSelect, { modelValue: picked, items: [SHORT, LONG], direction: 'asc' }),
          ]),
        ]),
    },
    { attachTo: host, global: { plugins: [vuetify, i18n] } },
  )
  wrappers.push(wrapper)
  await wrapper.vm.$nextTick()
  const root = wrapper.element as HTMLElement
  return {
    search: root.querySelector<HTMLElement>('.search')!,
    pills: [
      ...root.querySelectorAll<HTMLElement>('.pill'),
      root.querySelector<HTMLElement>('.library-sort')!,
    ],
    sortName: () => root.querySelector<HTMLElement>('.library-sort__name--shown')!,
  }
}

// By the middle: the select and the plain pills differ in height.
const middle = (element: HTMLElement) => {
  const rect = element.getBoundingClientRect()
  return Math.round(rect.top + rect.height / 2)
}

const width = (element: HTMLElement) => Math.round(element.getBoundingClientRect().width)

describe('a library filter row', () => {
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
  })

  it('keeps the search and the controls on one line where they fit', async () => {
    await page.viewport(1400, 800)
    const { search, pills } = await mountRow(1100)

    expect(new Set([search, ...pills].map(middle)).size).toBe(1)
  })

  it('moves the controls to a line of their own as one group', async () => {
    await page.viewport(1400, 800)
    const { search, pills } = await mountRow(700)

    expect(new Set(pills.map(middle)).size).toBe(1)
    expect(middle(pills[0]!)).toBeGreaterThan(middle(search))
  })

  it('fits the longest order, and keeps that width whichever is picked', async () => {
    await page.viewport(1400, 800)
    const short = await mountRow(1100, SHORT.value)
    const long = await mountRow(1100, LONG.value)

    expect(width(short.pills[2]!)).toBe(width(long.pills[2]!))
    const name = long.sortName()
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth)
  })

  // A window narrower than the three at their full width: the sort select
  // gives, rather than dropping to a line below the other two or squeezing
  // the toggle.
  it('lets only the sort select give when even its own line is short', async () => {
    await page.viewport(1400, 800)
    const { pills } = await mountRow(420)

    expect(new Set(pills.map(middle)).size).toBe(1)
    expect(width(pills[0]!)).toBe(88)
    expect(width(pills[1]!)).toBe(100)
    expect(pills[2]!.getBoundingClientRect().right).toBeLessThanOrEqual(420 + 1)
  })
})
