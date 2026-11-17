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
import { HELP_PAGES } from '@/services/help/docs'
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
  const longest = HELP_PAGES.reduce((a, b) => (b.body.length > a.body.length ? b : a))
  emitter.emit('openHelp', longest.id)
  // v-dialog's enter transition, measured any earlier mid-scale. Waited for
  // rather than timed, a fixed wait comes up short on a busy machine: the
  // bounding box includes the transform and offsetHeight does not, so they
  // agree once it is over, at whatever height the card really has.
  await expect
    .poll(
      () => {
        const card = document.querySelector<HTMLElement>('.help-dialog')
        return !!card && Math.abs(card.getBoundingClientRect().height - card.offsetHeight) <= 0.5
      },
      { timeout: 5000 },
    )
    .toBe(true)
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
    expect(card.getBoundingClientRect().height).toBeCloseTo(window.innerHeight * 0.7, 0)
  })

  describe('the contents beside a page whose last questions are short', () => {
    const entries = (card: HTMLElement) => [
      ...card.querySelectorAll<HTMLElement>('.help-dialog__toc-entry'),
    ]
    const marked = (card: HTMLElement) =>
      entries(card).flatMap((entry, i) =>
        entry.classList.contains('v-list-item--active') ? [i] : [],
      )

    async function openShortEnded() {
      const card = await open(1280, 900)
      emitter.emit('openHelp', 'faq/apps-and-api')
      await expect.poll(() => entries(card).length).toBeGreaterThan(2)
      return { card, content: card.querySelector('.help-dialog__content') as HTMLElement }
    }

    // Long enough for the scroll event of the jump itself to have come in.
    const settled = () =>
      new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)))

    it.each([1, 2])('mark the entry %i from the end when it is clicked', async (fromEnd) => {
      const { card, content } = await openShortEnded()
      const index = entries(card).length - fromEnd
      entries(card)[index]!.click()
      await expect.poll(() => marked(card)).toEqual([index])
      await settled()
      expect(marked(card)).toEqual([index])
      // What makes this worth a test: the page ended before the heading got to the top.
      expect(content.scrollTop + content.clientHeight).toBeGreaterThanOrEqual(
        content.scrollHeight - 1,
      )
    })

    it('follow the page again once it is scrolled', async () => {
      const { card, content } = await openShortEnded()
      const last = entries(card).length - 1
      entries(card)[last]!.click()
      await expect.poll(() => marked(card)).toEqual([last])
      await settled()

      content.scrollTop -= 600
      await expect.poll(() => marked(card)).not.toEqual([last])

      content.scrollTop = content.scrollHeight
      await expect.poll(() => marked(card)).toEqual([last])
    })
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
