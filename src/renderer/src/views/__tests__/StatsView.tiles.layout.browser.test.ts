// Real-browser test for the stat tiles' widths - flex-wrap resolution with
// intrinsic sizes, which jsdom has no layout for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@/assets/base.css'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import StatsView from '../StatsView.vue'

const vuetify = createVuetify({ components, directives })
let wrapper: VueWrapper | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  ;(i18n.global.locale as unknown as string) = 'de'
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  ;(i18n.global.locale as unknown as string) = 'en'
})

describe('the stat tiles', () => {
  /** "52 Tage 3 Std" was reported broken over two lines, which made its
   * whole row taller than the others. */
  it('keep every figure on one line, also beside a sidebar', async () => {
    await page.viewport(1000, 900)
    const store = useLibraryStore()
    store.fetchAllSongs = vi.fn()
    store.fetchStarred = vi.fn()
    store.fetchArtists = vi.fn()
    const day = 24 * 3600
    store.allSongs = Array.from({ length: 300 }, (_, i) =>
      makeSong(`s${i}`, { duration: Math.round((52 * day + 3 * 3600) / 300), playCount: 1 }),
    )
    wrapper = mount(StatsView, {
      attachTo: document.body,
      global: { plugins: [vuetify, i18n], stubs: { RankedList: true, PageLoader: true } },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const values = wrapper.findAll('.stat-tile__value').map((v) => v.element as HTMLElement)
    expect(values.some((v) => v.textContent!.includes('Tage'))).toBe(true)
    for (const value of values) {
      const lineHeight = parseFloat(getComputedStyle(value).lineHeight)
      expect(value.getBoundingClientRect().height, value.textContent!).toBeLessThan(
        lineHeight * 1.5,
      )
      // ...and inside its tile, not spilling over its edge.
      const tile = value.closest('.stat-tile')!.getBoundingClientRect()
      expect(value.getBoundingClientRect().right).toBeLessThanOrEqual(tile.right)
    }
  })

  /** The library's tiles at a laptop's width with the queue open: the sixth
   * sat alone on a second row, stretched across the whole page. */
  it('leaves no tile alone on a row of its own', async () => {
    await page.viewport(1000, 900)
    const store = useLibraryStore()
    store.fetchAllSongs = vi.fn()
    store.fetchStarred = vi.fn()
    store.fetchArtists = vi.fn()
    store.allSongs = Array.from({ length: 300 }, (_, i) =>
      makeSong(`s${i}`, { duration: 15000, playCount: 1, size: 700_000_000 }),
    )
    wrapper = mount(StatsView, {
      attachTo: document.body,
      global: { plugins: [vuetify, i18n], stubs: { RankedList: true, PageLoader: true } },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    for (const grid of wrapper.findAll('.stat-grid')) {
      const rows = new Map<number, number>()
      for (const tile of grid.findAll('.stat-tile')) {
        const top = Math.round(tile.element.getBoundingClientRect().top)
        rows.set(top, (rows.get(top) ?? 0) + 1)
      }
      expect([...rows.values()]).not.toContain(1)
    }
  })
})
