// Real-browser test: whether a line clips to its row is computed layout,
// which jsdom does not do - it would "pass" with the line running off the
// screen.
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@/assets/main.css'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import { makeSong } from '@/stores/__tests__/fixtures'
import MobileSongRow from '../MobileSongRow.vue'

const vuetify = createVuetify({ components, directives })
let wrapper: VueWrapper | null = null

describe('MobileSongRow', () => {
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  /** The artist line is ArtistCredit's inline <span>, which overflow does
   * nothing on: a long credit ran past the row and let the whole page pan
   * sideways. */
  it('clips a long artist credit to the row', async () => {
    await page.viewport(390, 844)
    setActivePinia(createPinia())
    const song = makeSong('s1', {
      title: 'Short',
      artist: 'Somebody & Somebody Else feat. A Third Person, A Fourth and Their Whole Orchestra',
    })
    wrapper = mount(
      { render: () => h(components.VApp, null, { default: () => h(MobileSongRow, { song }) }) },
      { attachTo: document.body, global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } } },
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    const row = document.querySelector('.mobile-song-row')!.getBoundingClientRect()
    const credit = document.querySelector('.artist-credit')!.getBoundingClientRect()
    expect(credit.right).toBeLessThanOrEqual(row.right)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
  })
})
