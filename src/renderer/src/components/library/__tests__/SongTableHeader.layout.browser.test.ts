// Real-browser test for the column headings' own voice - run via
// `pnpm test:layout`. Everything here is computed style off scoped CSS,
// which jsdom neither applies nor resolves: a jsdom version would report
// the same empty string whatever the rule said.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import '@/assets/base.css'
import { i18n, SUPPORTED_LOCALES } from '@/i18n'
import SongTableHeader from '../SongTableHeader.vue'
import SongRow from '../SongRow.vue'
import { emitter } from '@/emitter'
import { makeSong } from '@/stores/__tests__/fixtures'
import { OPTIONAL_SONG_COLUMNS, resolveSongColumns } from '@/services/library/songColumns'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []
const framesToRemove: HTMLElement[] = []

function mountHeader(props: Record<string, unknown> = {}) {
  const wrapper = mount(SongTableHeader, {
    props: {
      columns: resolveSongColumns(['album', 'year']),
      sortKey: 'year',
      ...props,
    },
    attachTo: document.body,
    global: { plugins: [vuetify, i18n] },
  })
  wrappers.push(wrapper)
  return wrapper
}

/** One column's heading button, by the column it sits in - not by its
 * label, which is translated and this runner's locale is whatever the
 * browser reports. */
function heading(column: string): HTMLElement {
  const found = document.querySelector(`[data-column="${column}"] .sort-header`)
  if (!found) throw new Error(`no column heading for ${column}`)
  return found as HTMLElement
}

describe('SongTableHeader', () => {
  // A row reads the playback store to tell whether it is the current song.
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    while (framesToRemove.length) framesToRemove.pop()?.remove()
    document.body.innerHTML = ''
  })

  /** Each heading is a <button>, and a form control does not inherit
   * text-transform or letter-spacing - the UA stylesheet resets both, and
   * `font: inherit` covers neither, since neither is part of the font
   * shorthand. So the row's casing and tracking have to be handed to the
   * buttons explicitly, and this is the test that notices when they are
   * not: the headings simply render in sentence case again, looking like
   * one more row of the list. */
  it('renders its headings in the small-label voice, buttons included', () => {
    mountHeader()

    const title = getComputedStyle(heading('title'))
    expect(title.textTransform).toBe('uppercase')
    expect(parseFloat(title.letterSpacing)).toBeGreaterThan(0)
    expect(Number(title.fontWeight)).toBeGreaterThanOrEqual(700)
  })

  /** Which column the list is sorted by, said in the app's amber rather
   * than by a 12px arrow in the same grey as the seven headings that mean
   * nothing at that moment. */
  it('lights the sorted column and leaves the others alone', () => {
    const wrapper = mountHeader({ sortKey: 'year' })

    // Read back from the theme rather than hard-coded: this runner builds
    // a bare Vuetify, whose primary is its own blue, while the app's is
    // Beacon's amber (main.ts). What matters is that the sorted heading
    // wears the theme's signal colour and the rest do not.
    const primary = getComputedStyle(wrapper.element as HTMLElement)
      .getPropertyValue('--v-theme-primary')
      .trim()
    const signal = `rgb(${primary
      .split(',')
      .map((part) => part.trim())
      .join(', ')})`

    expect(getComputedStyle(heading('year')).color).toBe(signal)
    expect(getComputedStyle(heading('title')).color).not.toBe(signal)
    expect(getComputedStyle(heading('album')).color).not.toBe(signal)
  })

  /** The complaint this answers: a heading that does not fit its column.
   * Every label is a translation, and the longest of the five decides -
   * "Plays" is 5 characters and "Reproducciones" is 14, in a column holding
   * a three-digit number. The widths in the registry were measured here (a
   * heading's real width is a browser question, not a jsdom one) and carry
   * roughly 10px of headroom each, because the app does not ship Inter:
   * every platform resolves the stack to a slightly different face.
   *
   * The tolerance is that headroom, not a licence to overflow - it is what
   * separates "this machine's font is a little wider" from the case this
   * catches, a heading that needs three times its column. */
  it('fits every heading in its own column, in every language', () => {
    const columns = resolveSongColumns(OPTIONAL_SONG_COLUMNS.map((column) => column.key))
    const frame = document.createElement('div')
    // Wide enough that nothing is shrinking: this is about the widths
    // themselves, not about what a narrow window does to them.
    frame.style.width = '2600px'
    document.body.append(frame)
    framesToRemove.push(frame)

    for (const locale of SUPPORTED_LOCALES) {
      i18n.global.locale = locale
      const header = mount(SongTableHeader, {
        props: { columns },
        attachTo: frame,
        global: { plugins: [vuetify, i18n] },
      })
      wrappers.push(header)

      for (const column of columns) {
        // The label, not the button around it: the button is capped at the
        // cell's width and clips nothing itself, so measuring it reports a
        // comfortable fit for a heading three times too wide. The ellipsis
        // lives on the label, and scrollWidth past clientWidth is exactly
        // when it appears - i.e. when the reader can no longer read it.
        const label = header.element.querySelector(
          `[data-column="${column.key}"] .sort-header__label`,
        ) as HTMLElement | null
        if (!label) continue
        const clipped = label.scrollWidth - label.clientWidth
        expect(clipped, `${column.key} heading in ${locale}`).toBeLessThanOrEqual(8)
      }
      header.unmount()
      wrappers.pop()
    }
    i18n.global.locale = 'en'
  })

  /** With every column switched on, the flexible ones used to be shrunk to
   * nothing - the title column measured 1px at 1280px wide and every
   * heading sat over its neighbour's column. The floor under each column is
   * what stops that; a table that no longer fits scrolls sideways instead,
   * which is a thing the reader can see and undo. */
  it('never shrinks a column below its floor, however many are on', () => {
    const columns = resolveSongColumns(OPTIONAL_SONG_COLUMNS.map((column) => column.key))
    const frame = document.createElement('div')
    frame.style.width = '1280px'
    document.body.append(frame)
    framesToRemove.push(frame)

    const header = mount(SongTableHeader, {
      props: { columns },
      attachTo: frame,
      global: { plugins: [vuetify, i18n] },
    })
    wrappers.push(header)

    for (const column of columns) {
      const cell = header.element.querySelector(`[data-column="${column.key}"]`) as HTMLElement
      const width = cell!.getBoundingClientRect().width
      expect(width, column.key).toBeGreaterThanOrEqual(parseInt(column.minWidth, 10) - 1)
    }
  })

  /** The select-all sits over the very checkboxes it switches, and it is
   * pulled left out of its own 44px cell to get there - while the heading
   * cells, unlike a row's, clip what runs past them. Both halves of that
   * are computed layout: a clipped checkbox still reports its full width in
   * jsdom, and so does one sitting 8px off. */
  it('puts the select-all over the row checkboxes, whole', async () => {
    const columns = resolveSongColumns(['album'])
    const frame = document.createElement('div')
    frame.style.width = '1280px'
    document.body.append(frame)
    framesToRemove.push(frame)

    const header = mount(SongTableHeader, {
      props: { columns, selectedCount: 1, totalCount: 4 },
      attachTo: frame,
      global: { plugins: [vuetify, i18n] },
    })
    wrappers.push(header)
    const row = mount(SongRow, {
      props: { columns, song: makeSong('a'), index: 0, selectionMode: true },
      attachTo: frame,
      global: {
        plugins: [vuetify, i18n],
        stubs: { RouterLink: true, CoverArt: true },
        mocks: { $emitter: emitter },
      },
    })
    wrappers.push(row)

    const selectAll = header.element.querySelector('.select-all-checkbox') as HTMLElement
    const rowBox = row.element.querySelector('.song-select-checkbox') as HTMLElement
    const cell = header.element.querySelector('[data-column="index"]') as HTMLElement

    // Same left edge as the checkbox in the row underneath, give or take
    // the rounding of two differently sized hit areas.
    expect(
      Math.abs(selectAll.getBoundingClientRect().left - rowBox.getBoundingClientRect().left),
    ).toBeLessThanOrEqual(1)
    // And not clipped by its own cell on the way there.
    expect(selectAll.getBoundingClientRect().left).toBeLessThan(
      cell.getBoundingClientRect().left + 1,
    )
    expect(getComputedStyle(cell).overflowX).toBe('visible')
  })

  /** The rating used to live inside the trailing cell, whose 200px were
   * measured here for exactly this reason: how wide Vuetify draws five
   * stars at `size="small"` is a browser question. As its own column it
   * carries that width itself, and a column too narrow for its own content
   * is the kind of thing only real layout reports. */
  it('holds five stars in the rating column', () => {
    const columns = resolveSongColumns(['rating'])
    const frame = document.createElement('div')
    frame.style.width = '1280px'
    document.body.append(frame)
    framesToRemove.push(frame)

    const row = mount(SongRow, {
      props: { columns, song: makeSong('a', { rating: 5 }), index: 0 },
      attachTo: frame,
      global: {
        plugins: [vuetify, i18n],
        stubs: { RouterLink: true, CoverArt: true },
        mocks: { $emitter: emitter },
      },
    })
    wrappers.push(row)

    const cell = row.element.querySelector('[data-column="rating"]') as HTMLElement
    const stars = row.element.querySelector('.song-rating') as HTMLElement

    expect(stars.getBoundingClientRect().width).toBeGreaterThan(0)
    expect(stars.getBoundingClientRect().width).toBeLessThanOrEqual(
      cell.getBoundingClientRect().width,
    )
  })

  /** Right-aligned columns hold figures, and proportional digits make each
   * of them a slightly different width - the column visibly wobbles as it
   * is scrolled. Computed style, so jsdom has nothing to say about it. */
  it('sets the figure columns in tabular numerals', () => {
    const columns = resolveSongColumns(['year', 'playCount'])
    const row = mount(SongRow, {
      props: { columns, song: makeSong('a'), index: 0 },
      attachTo: document.body,
      global: {
        plugins: [vuetify, i18n],
        stubs: { RouterLink: true, CoverArt: true },
        mocks: { $emitter: emitter },
      },
    })
    wrappers.push(row)

    for (const key of ['year', 'playCount', 'duration']) {
      const cell = row.element.querySelector(`[data-column="${key}"]`) as HTMLElement
      expect(getComputedStyle(cell).fontVariantNumeric, key).toContain('tabular-nums')
    }
  })

  /** The failure this whole arrangement exists to prevent: a heading
   * standing over the wrong column. The widths used to be written out twice,
   * once per file, and the only thing keeping them equal was a comment in
   * both saying they had to be. They now come from one array
   * (services/library/songColumns.ts) - and this is the test that notices if
   * a cell ever stops honouring it, which needs real flex resolution and so
   * cannot live in jsdom.
   *
   * Deliberately runs with every optional column on: a wrong width shows up
   * as drift that accumulates left to right, so the more columns there are,
   * the more visible it is. */
  it('stands each heading over its own column, at any width', () => {
    const columns = resolveSongColumns(OPTIONAL_SONG_COLUMNS.map((column) => column.key))
    const frame = document.createElement('div')
    document.body.append(frame)
    framesToRemove.push(frame)

    for (const width of ['1400px', '900px']) {
      frame.style.width = width
      const header = mount(SongTableHeader, {
        props: { columns },
        attachTo: frame,
        global: { plugins: [vuetify, i18n] },
      })
      const row = mount(SongRow, {
        props: { columns, song: makeSong('a'), index: 0 },
        attachTo: frame,
        global: {
          plugins: [vuetify, i18n],
          // CoverArt is left real: the cover column's width is one of the
          // things under test, and a stub is 0px wide.
          stubs: { RouterLink: true },
          mocks: { $emitter: emitter },
        },
      })
      wrappers.push(header, row)

      for (const column of columns) {
        const inHeader = header.element.querySelector(`[data-column="${column.key}"]`)
        const inRow = row.element.querySelector(`[data-column="${column.key}"]`)
        const left = inHeader!.getBoundingClientRect().left
        const rowLeft = inRow!.getBoundingClientRect().left
        // Sub-pixel rounding only - anything more means the two disagree
        // about a width somewhere to the left of this column.
        expect(Math.abs(left - rowLeft), `${column.key} at ${width}`).toBeLessThan(1)
      }
    }
  })
})
