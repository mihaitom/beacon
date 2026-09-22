// Real-browser tests for the letter divider on the Artists grid — run via
// `pnpm test:layout`. Two things jsdom cannot answer are checked here:
// flex-wrap resolution (a `flex-basis: 100%` divider has to push the next
// letter's cards onto a new line) and where a jumped-to letter lands on
// screen, which depends on the real scroll parent and VVirtualScroll's own
// measured offsets.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import '@/assets/base.css'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import ArtistsView from '../ArtistsView.vue'
import type { Artist } from '@/types/library'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

function artist(id: string, name: string, sortName: string): Artist {
  return {
    id,
    name,
    sortName,
    albumCount: 1,
    coverArtId: null,
    imageUrl: null,
    starred: false,
    rating: 0,
    albums: [],
  }
}

async function mountArtists(artists: Artist[], headerHeight = 0) {
  const store = useLibraryStore()
  store.fetchArtists = vi.fn().mockResolvedValue(undefined)
  store.artists = artists

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/artists/:id', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()

  // Stands in for the app bar and the sticky filter the view normally sits
  // under: without them the grid starts at the very top of the document and
  // a jump's landing position would not mean anything.
  if (headerHeight) {
    const spacer = document.createElement('div')
    spacer.style.height = `${headerHeight}px`
    document.body.appendChild(spacer)
  }

  const wrapper = mount(ArtistsView, {
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { DetailHeader: true, StickyFilter: true, ExactMatchSwitch: true },
    },
  })
  wrappers.push(wrapper)
  await wrapper.vm.$nextTick()
  return wrapper
}

async function settle(wrapper: VueWrapper) {
  for (let frame = 0; frame < 12; frame++) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await wrapper.vm.$nextTick()
  }
}

function dividerLabel(letter: string): HTMLElement {
  const label = [...document.querySelectorAll('.letter-divider__label')].find(
    (element) => element.textContent?.trim() === letter,
  )
  if (!label) throw new Error(`no divider for ${letter}`)
  return label as HTMLElement
}

describe('letter divider on the artists grid', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('starts each letter on a new row', async () => {
    await page.viewport(1200, 800)
    await mountArtists([
      artist('a1', 'Alpha', 'alpha'),
      artist('a2', 'Amber', 'amber'),
      artist('b1', 'Bravo', 'bravo'),
      artist('b2', 'Blue', 'blue'),
    ])

    const cards = [...document.querySelectorAll('.artist-card')].map((card) =>
      (card as HTMLElement).getBoundingClientRect(),
    )
    expect(cards).toHaveLength(4)
    // The two A cards share the first row...
    expect(Math.round(cards[0]!.top)).toBe(Math.round(cards[1]!.top))
    // ...and the first B card is on a row of its own below it.
    expect(cards[2]!.top).toBeGreaterThan(cards[1]!.top)

    const labels = [...document.querySelectorAll('.letter-divider__label')].map((label) =>
      label.textContent?.trim(),
    )
    expect(labels).toEqual(['A', 'B'])
  })

  it('lands a jumped-to letter in the upper half, its divider visible', async () => {
    await page.viewport(1200, 800)
    // 500 A artists, then B, then plenty of C: the jump to B has to scroll,
    // and there is enough below B that aligning B's row to the top is
    // actually reachable (a section at the very end of the list cannot be).
    const wrapper = await mountArtists(
      [
        ...Array.from({ length: 500 }, (_, i) =>
          artist(
            `a${i}`,
            `Artist ${String(i).padStart(4, '0')}`,
            `artist ${String(i).padStart(4, '0')}`,
          ),
        ),
        artist('b1', 'Bravo', 'bravo'),
        artist('b2', 'Blue', 'blue'),
        ...Array.from({ length: 200 }, (_, i) =>
          artist(
            `c${i}`,
            `Charlie ${String(i).padStart(4, '0')}`,
            `charlie ${String(i).padStart(4, '0')}`,
          ),
        ),
      ],
      320,
    )
    const vm = wrapper.vm as unknown as { jumpToLetter(letter: string): void }
    // Let the grid measure its width (column count) and render once before
    // jumping, the same as a real visit.
    await settle(wrapper)

    vm.jumpToLetter('B')
    await settle(wrapper)

    const rect = dividerLabel('B').getBoundingClientRect()
    // Visible, and in the upper half rather than centred or below it.
    expect(rect.top).toBeGreaterThan(0)
    expect(rect.top).toBeLessThan(window.innerHeight / 2)
  })
})
