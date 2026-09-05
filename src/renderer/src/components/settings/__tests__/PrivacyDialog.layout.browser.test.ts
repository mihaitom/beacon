// Real-browser test that the privacy dialog leaves the app's own chrome
// visible — run via `pnpm test:layout`. A height cap and whether the list
// inside scrolls are both things jsdom lays out as nothing at all.
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@/assets/base.css'
import { i18n } from '@/i18n'
import PrivacyDialog from '../PrivacyDialog.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

async function open(width: number, height: number) {
  await page.viewport(width, height)
  // Inside a v-app: without one there is no overlay container, and
  // v-dialog renders in the normal flow instead of fixed over the page —
  // which measures as a card hanging off the bottom of the viewport and
  // looks exactly like the bug this test is about.
  const wrapper = mount(
    {
      render: () =>
        h(components.VApp, null, {
          default: () => h(PrivacyDialog, { modelValue: true }),
        }),
    },
    { attachTo: document.body, global: { plugins: [vuetify, i18n] } },
  )
  wrappers.push(wrapper)
  // v-dialog's own enter transition — measured any earlier the card is
  // still mid-scale and reports a size it never actually has.
  await new Promise((resolve) => setTimeout(resolve, 450))
  return document.querySelector('.privacy-card') as HTMLElement
}

describe('PrivacyDialog layout', () => {
  afterEach(async () => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
    await page.viewport(1280, 900)
  })

  it.each([
    ['a desktop window', 1280, 900],
    ['a phone', 390, 844],
  ])('is capped well short of the whole screen on %s', async (_, w, h) => {
    // 70vh, so the bar at the top and the player at the bottom stay in
    // view behind it — the dialog reads as something opened *in* Beacon
    // rather than as a screen of its own. Vuetify's own default is around
    // 90%. Where the card sits within what is left is Vuetify's business,
    // not this rule's, so only the height is asserted.
    const card = await open(w, h)

    expect(card.getBoundingClientRect().height).toBeLessThanOrEqual(h * 0.7 + 1)
    expect(getComputedStyle(card).maxHeight).toBe(`${h * 0.7}px`)
  })

  it('lets the whole thing be read, scrolling inside the cap', async () => {
    // The assertion that matters is scrollHeight vs *clientHeight*, not vs
    // the card: a body taller than the card only proves the content is
    // long. It was — and it was also being clipped, with the last section
    // and the closing note unreachable, which the weaker check happily
    // passed.
    const card = await open(1280, 900)
    const body = card.querySelector('.v-card-text') as HTMLElement

    expect(getComputedStyle(body).overflowY).toBe('auto')
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight)

    // And the last thing in it can actually be brought into view.
    body.scrollTop = body.scrollHeight
    const foot = card.querySelector('.privacy-footnote')!.getBoundingClientRect()
    expect(foot.bottom).toBeLessThanOrEqual(card.getBoundingClientRect().bottom + 1)
    expect(foot.top).toBeGreaterThanOrEqual(card.getBoundingClientRect().top - 1)
  })
})
