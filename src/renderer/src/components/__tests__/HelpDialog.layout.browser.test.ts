// Real-browser test of the help dialog's height - run via `pnpm test:layout`.
// jsdom lays out nothing, and v-dialog's own flex rule on the card is what
// once stretched it past the 70vh it asks for.
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
// Same order as main.ts, see PrivacyDialog.layout.browser.test.ts.
import '@/assets/main.css'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import HelpDialog from '../HelpDialog.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

async function open(width: number, height: number, compact = false) {
  await page.viewport(width, height)
  // Inside a v-app, or v-dialog has no overlay container to be fixed in.
  const wrapper = mount(
    { render: () => h(components.VApp, null, { default: () => h(HelpDialog, { compact }) }) },
    {
      attachTo: document.body,
      // Real transitions: test-utils' stub is an element of its own between
      // the overlay and its content, and v-dialog's rules are child
      // selectors (`.v-dialog > .v-overlay__content > .v-card`) - with it
      // in the way, none of them apply and the test measures something the
      // app never shows.
      global: { plugins: [vuetify, i18n], stubs: { transition: false } },
    },
  )
  wrappers.push(wrapper)
  // The longest page, so a card that grows with its content would show it.
  emitter.emit('openHelp', 'party-mode')
  // v-dialog's enter transition, measured any earlier mid-scale.
  await new Promise((resolve) => setTimeout(resolve, 450))
  return document.querySelector('.help-dialog') as HTMLElement
}

describe('HelpDialog layout', () => {
  afterEach(async () => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
    await page.viewport(1280, 900)
  })

  it('is 70vh tall in a window, however long the page', async () => {
    const card = await open(1280, 900)
    expect(card.getBoundingClientRect().height).toBeCloseTo(900 * 0.7, 0)
  })

  it('scrolls the page and the contents inside it, not the card', async () => {
    const card = await open(1280, 900)
    const content = card.querySelector('.help-dialog__content') as HTMLElement
    expect(content.scrollHeight).toBeGreaterThan(content.clientHeight)
    expect(card.scrollHeight).toBeLessThanOrEqual(card.clientHeight + 1)
  })

  it('fills the screen on a phone', async () => {
    const card = await open(390, 844, true)
    expect(card.getBoundingClientRect().height).toBeCloseTo(844, 0)
  })
})
