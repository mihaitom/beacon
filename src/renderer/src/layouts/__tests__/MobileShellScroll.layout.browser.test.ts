// Real-browser test for what scrolls in the mobile shell - run via
// `pnpm test:layout`. jsdom lays nothing out and scrolls nothing, so a
// jsdom version of this would pass against any arrangement at all.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
// Same order as main.ts - see MobileAppBar.layout.browser.test.ts.
import '@/assets/main.css'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import MobileLayout from '../MobileLayout.vue'
import StickyFilter from '@/components/StickyFilter.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

// A page taller than any phone, the way every mobile view is: a plain
// block that grows with its content and sets no height of its own. A
// render function rather than a `template:` string - vitest's browser mode
// runs the production Vue build, which ships no runtime compiler.
const TallPage = {
  name: 'TallPage',
  render() {
    return h(
      'div',
      { class: 'tall-page' },
      Array.from({ length: 80 }, (_, index) =>
        h('div', { class: 'tall-page__row', style: 'height: 44px' }, `Row ${index + 1}`),
      ),
    )
  },
}

// The shape MobileLibraryView and MobileRadioView have: something that
// scrolls away above the filter, then the filter, then the list.
const FilteredPage = {
  name: 'FilteredPage',
  render() {
    return h('div', [
      h('div', { class: 'probe-heading', style: 'height: 120px' }, 'Heading'),
      h(StickyFilter, null, { default: () => h('input', { class: 'probe-search' }) }),
      ...Array.from({ length: 60 }, (_, index) =>
        h('div', { class: 'tall-page__row', style: 'height: 44px' }, `Row ${index + 1}`),
      ),
    ])
  },
}

function mountShell(page: object = TallPage) {
  const wrapper = mount(MobileLayout, {
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      mocks: { $route: { path: '/m/library', name: 'm-library' }, $router: { push: vi.fn() } },
      stubs: {
        RouterView: page,
        'router-view': page,
        MobilePlayerBar: true,
        CastTakeoverConfirmDialog: true,
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

describe('mobile shell scrolling', () => {
  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
    document.documentElement.classList.remove('mobile-shell')
  })

  /** The bars are fixed to the layout viewport, which iOS does not measure
   * the way the screen does - so as long as the document itself can
   * scroll, they drift. Reported 2026-09-07 from a PWA: the tab bar
   * travelling up the screen and staying in the middle of it. */
  it('scrolls the content pane, not the document', async () => {
    await page.viewport(390, 844)
    setActivePinia(createPinia())
    useAuthStore().capabilities.internetRadio = true
    const wrapper = mountShell()
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(document.querySelectorAll('.tall-page__row').length, 'the page never rendered').toBe(80)

    const main = document.querySelector('.v-main') as HTMLElement
    // The pane is the scroller, and it has something to scroll.
    expect(main.scrollHeight).toBeGreaterThan(main.clientHeight)
    // The document is not.
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight + 1)

    const bar = wrapper.get('.mobile-tabbar').element
    const before = bar.getBoundingClientRect().top
    main.scrollTop = 900
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

    expect(main.scrollTop, 'the pane did not scroll').toBeGreaterThan(0)
    // Which is the point: the bar stays where it is while it happens.
    expect(bar.getBoundingClientRect().top).toBeCloseTo(before, 0)
    expect(bar.getBoundingClientRect().bottom).toBeCloseTo(window.innerHeight, 0)
  })

  /** A sticky filter clamps against the pane, and the pane starts below the
   * app bar - so offsetting it by the bar's height as well (the desktop's
   * own --v-layout-top, which is right where the page itself scrolls) put
   * it a bar's height too low, with rows scrolling visibly through the
   * strip above it. Reported 2026-09-07, right after the pane became the
   * scroller. */
  it('clamps a sticky filter directly under the app bar', async () => {
    await page.viewport(390, 844)
    setActivePinia(createPinia())
    useAuthStore().capabilities.internetRadio = true
    const wrapper = mountShell(FilteredPage)
    await new Promise((resolve) => setTimeout(resolve, 80))

    const main = document.querySelector('.v-main') as HTMLElement
    const appBar = wrapper.get('.mobile-app-bar').element.getBoundingClientRect()
    const sticky = document.querySelector('.sticky-filter') as HTMLElement

    main.scrollTop = 400
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

    // Stuck, rather than still scrolling with the page.
    expect(sticky.getBoundingClientRect().top).toBeLessThan(200)
    // And flush against the bar: anything more is a gap for rows to show
    // through. The bar's own hairline is the tolerance.
    expect(sticky.getBoundingClientRect().top).toBeCloseTo(appBar.bottom, -0.5)
  })
})
