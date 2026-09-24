// Real-browser test for DetailHero.vue's `large` variant (the album page's
// header) - run via `pnpm test:layout`. Whether a long name wraps inside
// its column or pushes the page wider is line breaking and flex sizing,
// neither of which jsdom does.
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
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
})
