// Real-browser test for the "playing right now" highlight in the radio
// title log — run via `pnpm test:layout`. What it checks is a scoped CSS
// selector, which jsdom neither applies nor computes: a jsdom version
// passes whatever the rule says, including the `:first-child` this used to
// be, which stops matching the moment a date heading takes the first <li>
// slot in the list (see RadioTitleLog.vue's own comment).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import RadioTitleLog from '../RadioTitleLog.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 8, day, hour, minute).getTime() / 1000
}

function mountLog(entries: { title: string; at: number }[]) {
  const wrapper = mount(RadioTitleLog, {
    props: { entries },
    attachTo: document.body,
    global: { plugins: [vuetify, i18n], mocks: { $router: { push: () => {} } } },
  })
  wrappers.push(wrapper)
  return wrapper
}

/** The colour the browser actually resolved for the newest track line. */
function newestTrackColor(wrapper: VueWrapper): string {
  const items = wrapper.findAll('.title-log__item')
  expect(items.length).toBeGreaterThan(0)
  return getComputedStyle(items[0]!.find('.title-log__track').element).color
}

describe('RadioTitleLog highlight', () => {
  afterEach(() => {
    vi.useRealTimers()
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('highlights the newest entry even when a date heading comes above it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 6, 8, 30))

    // Nothing from today, so the very first <li> in the list is the
    // "Yesterday" heading rather than an entry.
    const dated = mountLog([{ title: 'Artist - Last night', at: at(5, 23, 50) }])
    expect(dated.find('.title-log__day').exists()).toBe(true)

    // Same component with no heading at all, as the reference for what
    // "highlighted" resolves to on this page.
    vi.setSystemTime(new Date(2026, 8, 5, 23, 55))
    const plain = mountLog([{ title: 'Artist - Tonight', at: at(5, 23, 50) }])
    expect(plain.find('.title-log__day').exists()).toBe(false)

    expect(newestTrackColor(dated)).toBe(newestTrackColor(plain))
  })
})
