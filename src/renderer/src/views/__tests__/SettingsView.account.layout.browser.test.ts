// Real-browser test for the account strip — run via `pnpm test:layout`.
// Everything it checks is invisible to jsdom: the media query that turns
// the row into two, the layout that decides where the wrapped button lands,
// and the computed spacing that decides whether a separator can be seen.
//
// Two things went wrong here without it. The strip is not a .setting, so
// the separator every other block in the panel gets skipped the one place
// two different kinds of block meet — and on a phone, where the row wraps,
// the logout button then sat left-aligned under the username with the
// language select butting straight up against it, belonging to neither.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
// The panel's hairlines are drawn with a custom property this app defines
// globally. Without it every `border: 1px solid var(--beacon-hairline)` is
// an invalid declaration and simply does not apply — the component would
// look untested-for reasons that have nothing to do with the component.
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import SettingsView from '../SettingsView.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

function mountSettings() {
  const wrapper = mount(SettingsView, {
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit: () => {}, on: () => {}, off: () => {} } },
      stubs: { ConnectButton: true, RemoteControlButton: true },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

function boxes(wrapper: VueWrapper) {
  const strip = wrapper.get('.account-strip').element
  return {
    strip: strip.getBoundingClientRect(),
    info: wrapper.get('.account-info').element.getBoundingClientRect(),
    button: strip.querySelector('.v-btn')!.getBoundingClientRect(),
  }
}

describe('SettingsView account strip', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().$patch({
      serverUrl: 'https://music.example.com',
      username: 'thomas',
      serverType: 'subsonic',
    })
  })

  afterEach(async () => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
    await page.viewport(1280, 900)
  })

  it('keeps the logout button on the identity row on a desktop width', async () => {
    await page.viewport(1280, 900)
    const { info, button } = boxes(mountSettings())

    // Same line: their vertical centres line up.
    expect(Math.abs((info.top + info.bottom) / 2 - (button.top + button.bottom) / 2)).toBeLessThan(
      4,
    )
  })

  it.each([
    ['a narrow phone', 320, 700],
    ['a phone', 390, 844],
  ])('keeps the whole row on one line on %s', async (_, w, h) => {
    // Asserted on the rule and not only on the geometry, deliberately. The
    // row happens to fit at these widths anyway — with a longer name, a
    // larger text size or a browser zoom it need not, and "one line" is
    // the thing being promised, not "one line as long as it is easy".
    await page.viewport(w, h)
    const wrapper = mountSettings()
    const { strip, info, button } = boxes(wrapper)

    expect(getComputedStyle(wrapper.get('.account-strip').element).flexWrap).toBe('nowrap')
    expect(Math.abs((info.top + info.bottom) / 2 - (button.top + button.bottom) / 2)).toBeLessThan(
      4,
    )
    expect(button.right).toBeLessThanOrEqual(strip.right + 1)
  })

  it('shortens the URL rather than pushing the button off the row', async () => {
    // The URL is the one part of this row that can lose its tail and still
    // say what it says.
    await page.viewport(390, 844)
    useAuthStore().$patch({
      serverUrl: 'https://a-really-quite-long-hostname.example.internal:8443/navidrome',
    })
    const wrapper = mountSettings()
    const url = wrapper.get('.account-info__url').element
    const { strip, info, button } = boxes(wrapper)

    expect(url.scrollWidth).toBeGreaterThan(url.clientWidth)
    expect(getComputedStyle(url).textOverflow).toBe('ellipsis')
    expect(Math.abs((info.top + info.bottom) / 2 - (button.top + button.bottom) / 2)).toBeLessThan(
      4,
    )
    expect(button.right).toBeLessThanOrEqual(strip.right + 1)
    expect(button.width).toBeGreaterThan(40)
  })

  it('does not offer keyboard shortcuts on the phone layout', async () => {
    // There is no keyboard to press any of them with, and a list of key
    // combinations is the one thing a touch device can do nothing at all
    // with. The dialog itself stays — the "?" key still opens it on a
    // desktop, and that is where the button advertises it.
    await page.viewport(390, 844)
    expect(mountSettings().find('.mdi-keyboard-outline').exists()).toBe(false)
  })

  it('offers them on a desktop window', async () => {
    await page.viewport(1280, 900)
    expect(mountSettings().find('.mdi-keyboard-outline').exists()).toBe(true)
  })

  it.each([
    ['a phone', 390, 844],
    ['a desktop window', 1280, 900],
  ])('separates the account block from the setting below it on %s', async (_, w, h) => {
    // The same separator every other block in a panel gets, drawn the same
    // way: 18px, the hairline, 18px.
    //
    // Measured on the spacing as well as on the border, because a border
    // alone is not the thing. The first attempt gave the strip a
    // border-bottom of its own, which passed a border-only assertion and
    // was still invisible in the app: at 14% alpha a line landing flush
    // against the filled select below it simply disappears into it. What
    // makes a hairline read as a separator is the room on both sides.
    await page.viewport(w, h)
    const setting = mountSettings().get('.beacon-panel .setting').element
    const style = getComputedStyle(setting)

    expect(style.borderTopStyle).toBe('solid')
    expect(parseFloat(style.borderTopWidth)).toBeGreaterThan(0)
    expect(parseFloat(style.paddingTop)).toBeGreaterThanOrEqual(12)
    expect(parseFloat(style.marginTop)).toBeGreaterThanOrEqual(12)
  })
})
