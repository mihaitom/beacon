// Real-browser tests for where a Fanart.tv banner sits in the header - run
// via `pnpm test:layout`. The placement is flex resolution against a
// measured text width, and the edge colours come from a real canvas; jsdom
// has neither.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import '@/assets/base.css'
import { i18n } from '@/i18n'
import { useFanartStore } from '@/stores/fanart'
import DetailHeader from '../DetailHeader.vue'

/** A banner at Fanart.tv's 1000x185, light grey to its edges. */
function bannerUrl(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 1000
  canvas.height = 185
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'rgb(200, 200, 200)'
  ctx.fillRect(0, 0, 1000, 185)
  ctx.fillStyle = '#b00'
  ctx.fillRect(20, 40, 300, 100)
  return canvas.toDataURL()
}

vi.mock('@/services/connect/fanart', () => ({
  getStoredImages: vi.fn(async (kind: string) =>
    kind === 'banner' ? [{ url: bannerUrl(), artists: [] }] : [],
  ),
}))
vi.mock('@/services/preloadImage', () => ({ preloadImage: vi.fn(async () => {}) }))

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
})

async function mountHeader(width: number) {
  await page.viewport(width, 400)
  setActivePinia(createPinia())
  useFanartStore().enabled = true
  const wrapper = mount(DetailHeader, {
    attachTo: document.body,
    props: { title: 'Songs', storedFanart: true },
    slots: { actions: '<button>Play random</button><button>Random from most played</button>' },
    global: { plugins: [vuetify, i18n] },
  })
  wrappers.push(wrapper)
  // Stored images, the edge colours' canvas read and the text measurement
  // all settle over a few ticks.
  await expect
    .poll(() =>
      wrapper.element.querySelector('.detail-header__backdrop--active')?.getAttribute('style'),
    )
    .toContain('--fill-right')
  await expect
    .poll(() => (wrapper.element as HTMLElement).style.getPropertyValue('--text-end'))
    .not.toBe('')
  const card = wrapper.element as HTMLElement
  const layer = card.querySelector('.detail-header__backdrop--active') as HTMLElement
  const banner = layer.querySelector('.detail-header__backdrop-slot')!.getBoundingClientRect()
  const buttons = [...card.querySelectorAll('button')].map((b) => b.getBoundingClientRect().right)
  return {
    card,
    rect: card.getBoundingClientRect(),
    layer,
    banner,
    textRight: Math.max(...buttons),
  }
}

describe('DetailHeader banner placement', () => {
  it('keeps the banner clear of the text where there is room, fading beside it', async () => {
    const { banner, textRight } = await mountHeader(2400)

    expect(banner.left).toBeGreaterThan(textRight)
  })

  it('centres the banner on a card wide enough for it', async () => {
    const { banner, rect } = await mountHeader(3000)

    const centre = banner.left + banner.width / 2
    expect(Math.abs(centre - (rect.left + rect.width / 2))).toBeLessThan(3)
  })

  it('holds a banner too wide to fit to the right edge, keeping its right end', async () => {
    const { banner, rect: card } = await mountHeader(1100)

    expect(banner.width).toBeGreaterThan(card.width)
    // Within the 2px the edge colours overlap its fully faded end by.
    expect(Math.abs(banner.right - card.right)).toBeLessThanOrEqual(3)
  })

  it('darkens behind the text, clearing before the banner starts', async () => {
    const { banner, textRight, card } = await mountHeader(2400)
    // Where the scrim has faded to nothing, from its computed gradient.
    const scrim = getComputedStyle(card.querySelector('.detail-header__scrim')!).backgroundImage
    const clearAt = Number(/rgba\(0, 0, 0, 0\) ([\d.]+)px/.exec(scrim)![1])

    expect(clearAt).toBeGreaterThan(textRight)
    expect(clearAt).toBeLessThanOrEqual(banner.left + 3)
  })

  it('keeps the art opaque behind the text, for the scrim to darken', async () => {
    const { layer } = await mountHeader(2000)

    expect(getComputedStyle(layer).maskImage).toBe('none')
  })

  it("paints the space beside the banner in the banner's own edge colour", async () => {
    const { layer } = await mountHeader(2000)

    expect(layer.style.getPropertyValue('--fill-left')).toContain('rgb(200, 200, 200)')
    expect(layer.style.getPropertyValue('--fill-right')).toContain('rgb(200, 200, 200)')
  })
})
