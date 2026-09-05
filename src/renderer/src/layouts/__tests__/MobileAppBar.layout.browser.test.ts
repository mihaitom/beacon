// Real-browser test for the mobile app bar's own height — run via
// `pnpm test:layout`. It carries the current view's actions now (Now
// Playing teleports its toolbar in, see NowPlayingView.vue), which is a
// different job from holding a title: at the 44px it started at, an icon
// button sat with barely a pixel of air above and below it.
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
// Same order as main.ts: the app's own stylesheet first, which is what
// makes base.css's @layer declaration the authoritative one. Reversed,
// @layer base lands behind Vuetify's utility layer and its `* { margin: 0 }`
// reset silently cancels every mb-*/pa-* in the markup under test.
import '@/assets/main.css'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import MobileLayout from '../MobileLayout.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

describe('mobile app bar', () => {
  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('is tall enough for the buttons it now carries', async () => {
    await page.viewport(390, 844)
    setActivePinia(createPinia())
    const wrapper = mount(MobileLayout, {
      attachTo: document.body,
      global: {
        plugins: [vuetify, i18n],
        mocks: { $route: { name: 'm-library' }, $router: { push: () => {} } },
        stubs: {
          RouterView: true,
          MobileTabBar: true,
          MobilePlayerBar: true,
          CastTakeoverConfirmDialog: true,
        },
      },
    })
    wrappers.push(wrapper)
    await new Promise((resolve) => setTimeout(resolve, 60))

    const bar = wrapper.get('.mobile-app-bar').element.getBoundingClientRect()
    const settings = wrapper.get('.mobile-app-bar .v-btn').element.getBoundingClientRect()

    expect(bar.height).toBeGreaterThanOrEqual(56)
    // Real air above and below, not a button wedged into the bar. This is
    // also what catches a `density` prop coming back: Vuetify's compact
    // density overrides the height outright rather than adjusting it, and
    // pinned the bar at 41px whatever the height said.
    expect(bar.height - settings.height).toBeGreaterThanOrEqual(8)
    // And a slot for a view to hang its own actions in.
    expect(wrapper.find('#mobile-app-bar-actions').exists()).toBe(true)

    // The logo is an mdi icon like the buttons beside it, and was 16 to
    // their 24 — next to them it read as a smaller version of them rather
    // than as a mark.
    const logo = wrapper.get('.mobile-app-bar__logo').element.getBoundingClientRect()
    const icon = wrapper.get('.mobile-app-bar .v-btn .v-icon').element.getBoundingClientRect()
    expect(logo.width).toBeCloseTo(icon.width, 0)
  })
})
