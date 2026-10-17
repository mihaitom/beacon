// Real-browser test: whether a long name fits its three lines is a question
// of the actual font metrics and wrapping, which jsdom does not have.
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
let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe("the album header's name", () => {
  /** Reported with this one, cut off after "Original…" at 1440px. */
  it.each([1440, 1100])('shows a long title whole at %ipx', async (width) => {
    await page.viewport(width, 900)
    // As on the album page: beside the cover, with the rating and the heart
    // to its right, in a page narrowed by the queue drawer.
    const host = document.createElement('div')
    host.style.width = `${width - 560}px`
    host.style.display = 'flex'
    host.style.height = '360px'
    document.body.append(host)
    wrapper = mount(DetailHero, {
      attachTo: host,
      props: {
        name: 'Clair Obscur: Expedition 33: Original Soundtrack',
        large: true,
        coverSize: 254,
        starred: false,
        rating: 0,
      },
      global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const name = wrapper.get('h1').element as HTMLElement
    expect(name.scrollHeight).toBeLessThanOrEqual(name.clientHeight + 1)
  })
})
