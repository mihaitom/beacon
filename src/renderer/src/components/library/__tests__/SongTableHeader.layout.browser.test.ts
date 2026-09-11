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
import { i18n } from '@/i18n'
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
