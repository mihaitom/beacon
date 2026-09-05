// Real-browser test for the column headings' own voice - run via
// `pnpm test:layout`. Everything here is computed style off scoped CSS,
// which jsdom neither applies nor resolves: a jsdom version would report
// the same empty string whatever the rule said.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import '@/assets/base.css'
import { i18n } from '@/i18n'
import SongTableHeader from '../SongTableHeader.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

function mountHeader(props: Record<string, unknown> = {}) {
  const wrapper = mount(SongTableHeader, {
    props: { showAlbum: true, showYear: true, sortKey: 'year', ...props },
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
  const found = document.querySelector(`.song-${column} .sort-header`)
  if (!found) throw new Error(`no column heading in .song-${column}`)
  return found as HTMLElement
}

describe('SongTableHeader', () => {
  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
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
})
