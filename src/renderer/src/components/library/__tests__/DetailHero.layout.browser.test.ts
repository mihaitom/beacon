// Real-browser test for DetailHero.vue's `large` variant (the album page's
// header) - run via `pnpm test:layout`. Whether a long name wraps inside
// its column or pushes the page wider is line breaking and flex sizing,
// neither of which jsdom does.
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
import DetailHero from '../DetailHero.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

describe('DetailHero large layout', () => {
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
  })

  it('wraps a long name inside its column instead of widening the page', async () => {
    await page.viewport(1400, 900)
    document.body.style.margin = '0'
    const wrapper = mount(DetailHero, {
      props: {
        name: 'Clair Obscur: Expedition 33: Original Soundtrack',
        coverSize: 400,
        large: true,
      },
      attachTo: document.body,
      global: { plugins: [vuetify, i18n] },
    })
    wrappers.push(wrapper)

    const name = document.querySelector('.detail-hero__name')!.getBoundingClientRect()
    const lineHeight = parseFloat(
      getComputedStyle(document.querySelector('.detail-hero__name')!).lineHeight,
    )

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1400)
    expect(name.height).toBeGreaterThan(lineHeight * 1.5)
    // Stops short of the right half, where the page's photo backdrop is.
    expect(name.right).toBeLessThan(1400 * 0.75)
  })

  /** A hero inside a frame of `width`, the way a page narrowed by a tablet
   * or the open queue drawer hands it one. */
  async function mountInFrame(width: number, slots: Record<string, () => unknown> = {}) {
    await page.viewport(1400, 900)
    document.body.style.margin = '0'
    const frame = document.createElement('div')
    frame.style.width = `${width}px`
    document.body.appendChild(frame)
    const wrapper = mount(DetailHero, {
      props: {
        name: 'Koala and a Rather Longer Album Name',
        coverSize: 200,
        large: true,
        rating: 0,
        starred: false,
      },
      slots,
      attachTo: frame,
      global: { plugins: [vuetify, i18n] },
    })
    wrappers.push(wrapper)
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
    return { rect }
  }

  it('keeps the name clear of the rating and heart on a narrow page', async () => {
    const { rect } = await mountInFrame(560)

    expect(rect('.detail-hero__name').right).toBeLessThanOrEqual(
      rect('.detail-hero__controls').left,
    )
  })

  it('keeps the cover by the name when the text beside it is the taller one', async () => {
    // The album page on a tablet: its paragraph makes the text column taller
    // than the cover, and each line that loaded used to push the cover down.
    const { rect } = await mountInFrame(900, {
      description: () => h('div', { style: { height: '260px' } }),
    })

    expect(rect('.detail-hero__cover').top).toBeCloseTo(rect('.detail-hero__main').top, 0)
  })
})
