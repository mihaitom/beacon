// Real-browser test for the tab bar's own width - run via `pnpm test:layout`.
// jsdom computes no flex layout at all, so a jsdom version of this would
// assert against numbers the app never has.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { nextTick, reactive } from 'vue'
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
import MobileTabBar from '@/components/mobile/MobileTabBar.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

// v-bottom-navigation needs v-app's layout injection, so this mounts the
// shell rather than the bar on its own.
function mountShell(push: () => void, route = reactive({ path: '/m/library', name: 'm-library' })) {
  const wrapper = mount(MobileLayout, {
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      mocks: { $route: route, $router: { push } },
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
    i18n.global.locale = 'en'
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

  /** A label longer than its own fifth of the bar used to overflow the
   * button and be clipped mid-word at both ends, because the span's
   * `max-width: 100%` resolved against Vuetify's .v-btn__content, which has
   * no width of its own. French is the shipped language that shows it
   * ("File d'attente", "Lecture en cours"); German lost its long one when
   * the queue tab was shortened, which is exactly why this is pinned to a
   * language rather than to whatever the default one says today. */
  it.each([320, 390])('keeps a long label inside its own tab at %ipx', async (width) => {
    await page.viewport(width, 844)
    setActivePinia(createPinia())
    useAuthStore().capabilities.internetRadio = true
    i18n.global.locale = 'fr'
    const wrapper = mountShell(vi.fn())
    await new Promise((resolve) => setTimeout(resolve, 80))

    for (const button of wrapper.findAll('.mobile-tabbar .v-btn')) {
      const tab = button.element.getBoundingClientRect()
      const label = button.get('.mobile-tabbar__label')
      const box = label.element.getBoundingClientRect()
      const text = label.text()
      expect(box.left, `"${text}" spills left of its tab`).toBeGreaterThanOrEqual(tab.left - 0.5)
      expect(box.right, `"${text}" spills right of its tab`).toBeLessThanOrEqual(tab.right + 0.5)
    }
  })

  /** Where the bar really is at the bottom edge of the screen - installed
   * as a PWA - it keeps an empty strip below the buttons, because that edge
   * is the strip both phone platforms listen on for their own swipe-up
   * gesture: a tap in a button's lower half was as likely to background the
   * app as to switch tabs.
   *
   * Two halves, because they are two different regressions: the strip has
   * to be there at all, and it has to have come out of the bar's *height*
   * rather than out of the buttons - padding without the matching height
   * would squeeze the touch targets instead of moving them up. Floors
   * rather than equalities, so settling on a different gap one day does not
   * turn this red for no reason.
   *
   * The display mode is set on the component rather than emulated: neither
   * Playwright nor the browser runner can put a page into standalone mode,
   * and the media query itself is one line with nothing to get wrong. */
  it('keeps the tabs clear of the bottom edge on a screen it owns', async () => {
    await page.viewport(390, 844)
    setActivePinia(createPinia())
    useAuthStore().capabilities.internetRadio = true
    const wrapper = mountShell(vi.fn())
    await new Promise((resolve) => setTimeout(resolve, 80))

    wrapper.findComponent(MobileTabBar).vm.atScreenEdge = true
    await nextTick()

    const bar = wrapper.get('.mobile-tabbar').element.getBoundingClientRect()
    expect(Math.round(bar.bottom), 'the bar has left the bottom edge itself').toBe(844)

    for (const button of wrapper.findAll('.mobile-tabbar .v-btn')) {
      const tab = button.element.getBoundingClientRect()
      const label = button.text().replace(/\s+/g, ' ')
      expect(
        bar.bottom - tab.bottom,
        `"${label}" reaches the gesture strip`,
      ).toBeGreaterThanOrEqual(8)
      expect(tab.height, `"${label}" lost height to the gap`).toBeGreaterThanOrEqual(44)
    }
  })

  /** ...and in an ordinary browser tab it does not, which is what this
   * runner is. There the browser's own toolbar sits below the bar rather
   * than the gesture strip, and the same empty strip was just a band of
   * dead space between the tabs and that toolbar. */
  it('leaves no gap when the browser has its own chrome below', async () => {
    await page.viewport(390, 844)
    setActivePinia(createPinia())
    useAuthStore().capabilities.internetRadio = true
    const wrapper = mountShell(vi.fn())
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(
      wrapper.findComponent(MobileTabBar).vm.atScreenEdge,
      'the runner is not in standalone mode, so this is the honest default',
    ).toBe(false)

    const bar = wrapper.get('.mobile-tabbar').element.getBoundingClientRect()
    for (const button of wrapper.findAll('.mobile-tabbar .v-btn')) {
      const tab = button.element.getBoundingClientRect()
      const label = button.text().replace(/\s+/g, ' ')
      expect(bar.bottom - tab.bottom, `"${label}" leaves dead space below it`).toBeLessThanOrEqual(
        1,
      )
    }
  })

  /** Which tab the bar picks out has to follow the *route*, however it was
   * reached - and it did not: VBtn takes the `v-btn--active` class from its
   * own `active` prop but its *colour* from the button group's selection,
   * and nothing was driving that group. Only tapping a tab ever moved it,
   * so every other way of navigating left the previous tab coloured:
   * opening an album from Now Playing kept Now Playing lit in the library,
   * and reaching Now Playing through the mini player left whichever tab was
   * open before it lit instead.
   *
   * Asserted on the rendered colour rather than on Vuetify's own selected
   * class: the colour is what was actually wrong on screen, it survives
   * that class being renamed, and it is the half jsdom cannot answer.
   *
   * No tap anywhere in here, deliberately - a tap is the one path that
   * always worked. */
  it('follows the route rather than the last tab tapped', async () => {
    await page.viewport(390, 844)
    setActivePinia(createPinia())
    useAuthStore().capabilities.internetRadio = true
    const route = reactive({ path: '/m/library', name: 'm-library' })
    const wrapper = mountShell(vi.fn(), route)
    await new Promise((resolve) => setTimeout(resolve, 80))

    const tabs = ['/m/now-playing', '/m/queue', '/m/playlists', '/m/library', '/m/radio']
    /** The one tab rendered in a colour no other tab has, or -1 when they
     * all match and nothing is picked out. */
    const litTab = () => {
      const colours = wrapper
        .findAll('.mobile-tabbar .v-btn')
        .map((b) => getComputedStyle(b.element).color)
      const tally = new Map<string, number>()
      for (const colour of colours) tally.set(colour, (tally.get(colour) ?? 0) + 1)
      return colours.findIndex((colour) => tally.get(colour) === 1)
    }

    expect(tabs[litTab()], 'the open tab is not picked out at all').toBe('/m/library')

    // What tapping the mini player does.
    route.path = '/m/now-playing'
    route.name = 'm-now-playing'
    await nextTick()
    expect(tabs[litTab()], 'the tab left behind stayed lit').toBe('/m/now-playing')

    // ...and what tapping the album cover on Now Playing does.
    route.path = '/m/albums/42'
    route.name = 'm-album-detail'
    await nextTick()
    expect(litTab(), 'a tab is still lit on a sub-page').toBe(-1)
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
