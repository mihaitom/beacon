// Real-browser test for the tab bar's own width - run via `pnpm test:layout`.
// jsdom computes no flex layout at all, so a jsdom version of this would
// assert against numbers the app never has.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
// Same order as main.ts - see MobileAppBar.layout.browser.test.ts for why
// the app's own stylesheet has to come first.
import '@/assets/main.css'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import MobileLayout from '@/layouts/MobileLayout.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

// v-bottom-navigation needs v-app's layout injection, so this mounts the
// shell rather than the bar on its own.
function mountShell(push: () => void) {
  const wrapper = mount(MobileLayout, {
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      mocks: { $route: { path: '/m/library', name: 'm-library' }, $router: { push } },
      stubs: { RouterView: true, MobilePlayerBar: true, CastTakeoverConfirmDialog: true },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

describe('mobile tab bar', () => {
  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
  })

  /** Five tabs at Vuetify's own 80px button minimum are 400px, which is
   * wider than every common phone - the row centred itself and hung off
   * both ends, so the outer two lost a slice and part of their touch
   * target. Radio, being last, was the one that would not open.
   *
   * Checked at four widths rather than one: the overflow grows as the
   * screen narrows, and 320px is where it used to be 80px. */
  it.each([320, 360, 390, 430])('keeps every tab inside the bar at %ipx', async (width) => {
    await page.viewport(width, 844)
    setActivePinia(createPinia())
    useAuthStore().capabilities.internetRadio = true
    const wrapper = mountShell(vi.fn())
    await new Promise((resolve) => setTimeout(resolve, 80))

    const bar = wrapper.get('.mobile-tabbar').element.getBoundingClientRect()
    const buttons = wrapper.findAll('.mobile-tabbar .v-btn')
    expect(buttons).toHaveLength(5)

    for (const button of buttons) {
      const tab = button.element.getBoundingClientRect()
      const label = button.text().replace(/\s+/g, ' ')
      expect(tab.left, `"${label}" starts left of the bar`).toBeGreaterThanOrEqual(bar.left - 0.5)
      expect(tab.right, `"${label}" runs past the bar`).toBeLessThanOrEqual(bar.right + 0.5)
    }
  })

  /** The whole point of the above: the last tab has to be tappable, and at
   * its own centre rather than at whatever slice of it stayed on screen. */
  it('opens Radio when its tab is tapped', async () => {
    await page.viewport(360, 844)
    setActivePinia(createPinia())
    useAuthStore().capabilities.internetRadio = true
    const push = vi.fn()
    const wrapper = mountShell(push)
    await new Promise((resolve) => setTimeout(resolve, 80))

    const radio = wrapper.findAll('.mobile-tabbar .v-btn').at(-1)!
    const tab = radio.element.getBoundingClientRect()
    const hit = document.elementFromPoint(tab.left + tab.width / 2, tab.top + tab.height / 2)
    expect(hit && radio.element.contains(hit), 'something else owns the middle of the tab').toBe(
      true,
    )

    await radio.trigger('click')
    expect(push).toHaveBeenCalledWith('/m/radio')
  })
})
