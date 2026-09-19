// Real-browser test for the transport row's own layout - run via
// `pnpm test:layout`. jsdom computes no grid or flex layout at all, so a
// jsdom version of this would assert against numbers the app never has.
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
// Same order as main.ts - see MobileAppBar.layout.browser.test.ts for why
// the app's own stylesheet has to come first.
import '@/assets/main.css'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import MobileTransportControls from '../MobileTransportControls.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

function mountControls() {
  const wrapper = mount(
    { render: () => h(components.VApp, null, { default: () => h(MobileTransportControls) }) },
    {
      attachTo: document.body,
      global: {
        plugins: [vuetify, i18n],
        stubs: { SongWaveform: true, MobileDevicePicker: true },
      },
    },
  )
  wrappers.push(wrapper)
  return wrapper
}

describe('mobile transport row', () => {
  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
  })

  /** Three buttons sit left of play and three right of it, but either
   * side can lose one (autoplay where the server cannot suggest similar
   * songs) - and the sides must not push play off the middle of the
   * screen when they do. Checked across the common phone widths, since
   * the row is at its tightest on the narrow ones. */
  it.each([320, 360, 390, 430])('keeps the play button centred at %ipx', async (width) => {
    await page.viewport(width, 844)
    setActivePinia(createPinia())
    const wrapper = mountControls()
    await new Promise((resolve) => setTimeout(resolve, 80))

    const row = wrapper.get('.mobile-transport__row').element.getBoundingClientRect()
    const play = wrapper.get('.mobile-transport__play-btn').element.getBoundingClientRect()

    const rowCentre = row.left + row.width / 2
    const playCentre = play.left + play.width / 2
    expect(Math.abs(playCentre - rowCentre)).toBeLessThanOrEqual(1)
  })

  /** The row grew from five buttons to seven; the ones on the ends are
   * the first to be pushed out of the screen if it ever stops fitting. */
  it.each([320, 360, 390, 430])('keeps every button inside the row at %ipx', async (width) => {
    await page.viewport(width, 844)
    setActivePinia(createPinia())
    const wrapper = mountControls()
    await new Promise((resolve) => setTimeout(resolve, 80))

    const row = wrapper.get('.mobile-transport__row').element.getBoundingClientRect()
    const buttons = wrapper.findAll('.mobile-transport__row .v-btn')

    for (const button of buttons) {
      const box = button.element.getBoundingClientRect()
      const icon = button.find('.v-icon').classes().join(' ')
      expect(box.left, `${icon} starts left of the row`).toBeGreaterThanOrEqual(row.left - 0.5)
      expect(box.right, `${icon} runs past the row`).toBeLessThanOrEqual(row.right + 0.5)
    }
  })
})
