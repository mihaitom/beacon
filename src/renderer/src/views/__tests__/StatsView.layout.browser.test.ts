// Real-browser test: the page is built from container queries, clamp() and an
// SVG sized by its height, none of which jsdom lays out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@/assets/base.css'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import * as playHistory from '@/services/connect/playHistory'
import StatsView from '../StatsView.vue'

vi.mock('@/services/connect/playHistory', () => ({
  recordListen: vi.fn(),
  getPlayHistorySummary: vi.fn(),
  getPlayHistoryAccounts: vi.fn().mockResolvedValue([]),
  saveMilestones: vi.fn().mockResolvedValue({}),
  getImportStatus: vi.fn().mockResolvedValue({ status: 'done' }),
  startImport: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })
let wrapper: VueWrapper | null = null

async function mountPage(width: number): Promise<HTMLElement> {
  await page.viewport(width, 900)
  const store = useLibraryStore()
  store.fetchAllSongs = vi.fn()
  store.fetchStarred = vi.fn()
  store.fetchArtists = vi.fn()
  store.allSongs = Array.from({ length: 40 }, (_, i) =>
    makeSong(`s${i}`, {
      title: `A title long enough to have to give way ${i}`,
      artistId: `a${i}`,
      albumId: `b${i}`,
      genre: `Genre ${i}`,
      playCount: 400 - i,
      duration: 200,
      year: 1960 + i,
      format: 'flac',
    }),
  )
  const now = Date.now() / 1000
  vi.mocked(playHistory.getPlayHistorySummary).mockResolvedValue({
    available: true,
    total: 400,
    timestamps: Array.from({ length: 400 }, (_, i) => now - (400 - i) * 80000),
    live_since: null,
    recent_plays: {},
    top: { songs: [], artists: [], albums: [], genres: [] },
    milestones: { plays: 100000, hours: 100000, streak: 100000 },
  })
  wrapper = mount(StatsView, {
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      // A stubbed <transition> is an element of its own, and a grid item with it.
      stubs: { CoverArt: true, RouterLink: RouterLinkStub, transition: false },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  return wrapper.element as HTMLElement
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('the Stats page', () => {
  it.each([360, 768, 1440, 3440])('does not run off the side at %ipx', async (width) => {
    const root = await mountPage(width)
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1)
    for (const section of root.querySelectorAll<HTMLElement>('section')) {
      expect(section.getBoundingClientRect().right).toBeLessThanOrEqual(width + 1)
    }
  })

  it('keeps the hero on the screen on an ultrawide', async () => {
    const root = await mountPage(3440)
    expect(root.querySelector('.stats-hero')!.getBoundingClientRect().height).toBeLessThan(800)
    expect(root.querySelector('.stats-record')!.getBoundingClientRect().width).toBeGreaterThan(600)
  })

  it('keeps a whole record inside the hero on a phone', async () => {
    const root = await mountPage(360)
    const hero = root.querySelector('.stats-hero')!.getBoundingClientRect()
    const record = root.querySelector('.stats-record')!.getBoundingClientRect()
    expect(record.left).toBeGreaterThanOrEqual(hero.left)
    expect(record.right).toBeLessThanOrEqual(hero.right)
    expect(record.height).toBeGreaterThan(150)
  })

  it('keeps a fanned-out pile of records inside the hero on a phone', async () => {
    const root = await mountPage(360)
    await vi.waitFor(() => expect(root.querySelector('.stats-shelf')).not.toBeNull())
    const style = document.createElement('style')
    style.textContent = '.stats-shelf * { transition: none !important; animation: none !important }'
    document.head.append(style)
    const hero = root.querySelector('.stats-hero')?.getBoundingClientRect() as DOMRect

    for (const pile of root.querySelectorAll('.stats-shelf__pile')) {
      pile.classList.add('is-open')
      for (const disc of pile.querySelectorAll('.stats-shelf__disc')) {
        const box = disc.getBoundingClientRect()
        expect(box.left).toBeGreaterThanOrEqual(hero.left)
        expect(box.right).toBeLessThanOrEqual(hero.right)
      }
      pile.classList.remove('is-open')
    }
    style.remove()
  })

  it('shows fewer weeks on a phone, large enough to tell apart', async () => {
    const root = await mountPage(360)
    const shown = [...root.querySelectorAll<HTMLElement>('.stats-year__week')].filter(
      (week) => getComputedStyle(week).display !== 'none',
    )
    expect(shown.length).toBeLessThan(53)
    const day = shown[0]!.querySelector('.stats-year__day')!.getBoundingClientRect()
    expect(day.width).toBeGreaterThan(8)
  })
})
