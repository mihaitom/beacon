// Real-browser test for the genre crates' grid - container queries and text
// wrapping, which jsdom has no layout for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@/assets/main.css'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import GenresView from '../GenresView.vue'

const vuetify = createVuetify({ components, directives })
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
})
let wrapper: VueWrapper | null = null

/** Long single words, as real libraries name their genres. */
const GENRES = [
  'Contemporary R&B',
  'Electronic',
  'Instrumental',
  'Alternative',
  'Soundtrack',
  'Country',
  'Hip Hop',
  'Pop',
]

const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)))

/** Every word of an element's text that the browser split over two lines. */
function brokenWords(element: Element): string[] {
  const text = element.firstChild!
  const broken: string[] = []
  for (const match of text.textContent!.matchAll(/\S+/g)) {
    const range = document.createRange()
    range.setStart(text, match.index)
    range.setEnd(text, match.index + match[0].length)
    if (range.getClientRects().length > 1) broken.push(match[0])
  }
  return broken
}

beforeEach(async () => {
  setActivePinia(createPinia())
  const library = useLibraryStore()
  vi.spyOn(library, 'fetchGenres').mockResolvedValue()
  vi.spyOn(library, 'fetchAlbums').mockResolvedValue()
  library.allSongs = GENRES.flatMap((genre, rank) =>
    Array.from({ length: 20 - rank }, (_, i) => makeSong(`${genre}-${i}`, { genre })),
  )
  wrapper = mount(GenresView, {
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { DetailHeader: true, CoverArt: true, AlphabetIndexBar: true },
    },
  })
  await document.fonts.ready
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('the genre crates', () => {
  /** "Electron|ic" and "Coun|try" were broken mid-word in crates too narrow
   * for their name beside the records. */
  it('never break a genre name inside a word', async () => {
    for (let width = 480; width <= 3200; width += 40) {
      await page.viewport(width, 900)
      await frame()
      for (const name of document.querySelectorAll('.genre-crate__name')) {
        if (!(name as HTMLElement).offsetParent) continue
        expect(brokenWords(name), `${width}px`).toEqual([])
      }
    }
  })

  it('always fill their last row', async () => {
    for (let width = 480; width <= 3200; width += 40) {
      await page.viewport(width, 900)
      await frame()
      const shown = [...document.querySelectorAll<HTMLElement>('.genre-crate')].filter(
        (crate) => crate.offsetParent,
      )
      const columns = getComputedStyle(
        document.querySelector('.genre-crates')!,
      ).gridTemplateColumns.split(' ').length
      expect(shown.length % columns, `${width}px: ${shown.length} in ${columns}`).toBe(0)
    }
  })
})
