// Real-browser layout tests for the discover dialog's result cards — run
// via `pnpm test:layout` (see vitest.browser.config.ts). This is the half
// RadioView.test.ts cannot check at all: jsdom applies no scoped CSS, so
// grid areas, flex-wrap and text truncation all read back as their initial
// values there. It matters more here than usual because the dialog used to
// be a data table switched off on phones entirely — "does it fit a phone"
// is the whole reason it changed.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import '@/assets/base.css'
import { i18n } from '@/i18n'
import * as radioBrowser from '@/services/connect/radioBrowser'
import RadioDiscoverDialog from '../RadioDiscoverDialog.vue'
import type { RadioBrowserStation } from '@/services/connect/radioBrowser'

// Spelled out rather than spread over an `await importOriginal()`: that
// form deadlocks the browser runner, and it does so while the module graph
// is still loading, so no test timeout ever fires — the file simply sits at
// [queued] and the whole run never finishes. Nothing is lost by listing the
// three functions instead; everything else this module exports is a type,
// which is gone by the time the mock matters.
vi.mock('@/services/connect/radioBrowser', () => ({
  searchRadioBrowser: vi.fn(),
  listRadioBrowserCountries: vi.fn().mockResolvedValue([]),
  registerRadioBrowserClick: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })

function makeResult(overrides: Partial<RadioBrowserStation> = {}): RadioBrowserStation {
  return {
    stationuuid: 'uuid-1',
    name: 'Example FM',
    url: 'http://example.com/stream',
    homepage: 'https://example.com',
    favicon: '',
    country: 'Germany',
    state: 'Bavaria',
    languagecodes: 'en,de',
    tags: 'pop,rock',
    codec: 'MP3',
    bitrate: 128,
    votes: 42,
    clickcount: 7,
    clicktrend: -2,
    lastcheckok: true,
    ...overrides,
  } as RadioBrowserStation
}

let currentWrapper: VueWrapper | null = null

async function openDiscover(width: number, results: RadioBrowserStation[], compact = false) {
  if (currentWrapper) {
    currentWrapper.unmount()
    currentWrapper = null
  }
  await page.viewport(width, 800)
  setActivePinia(createPinia())
  vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue(results)

  const wrapper = mount(
    {
      render: () =>
        h(components.VApp, null, {
          default: () => h(RadioDiscoverDialog, { modelValue: true, compact }),
        }),
    },
    {
      attachTo: document.body,
      global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
    },
  )
  currentWrapper = wrapper
  await flushPromises()
  await wrapper.vm.$nextTick()
  // Long enough for v-dialog's own enter transition to finish. Measured
  // any earlier, the overlay is still mid-scale and centred on its
  // transform origin — it reported 264px wide at x=195 inside a 390px
  // viewport, which reads exactly like an overflow bug and is not one.
  await new Promise((resolve) => setTimeout(resolve, 450))
  return wrapper
}

function rect(el: Element): DOMRect {
  return (el as HTMLElement).getBoundingClientRect()
}

describe('RadioDiscoverDialog layout', () => {
  afterEach(() => {
    currentWrapper?.unmount()
    currentWrapper = null
    vi.clearAllMocks()
  })

  /** Measured against the list rather than the viewport: v-dialog keeps a
   * scale transform on .v-overlay__content, so absolute page coordinates
   * inside a dialog are a picture of that transform, not of the layout.
   * scrollWidth vs clientWidth is the actual question anyway — whether
   * anything inside needs more width than it was given. */
  it('lays every card out inside the list, with nothing spilling sideways', async () => {
    await openDiscover(390, [
      makeResult(),
      makeResult({ stationuuid: 'uuid-2', name: 'B'.repeat(120) }),
    ])

    const list = document.querySelector('.discover-results') as HTMLElement
    expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth + 1)

    const cards = [...document.querySelectorAll('.discover-card')] as HTMLElement[]
    expect(cards.length).toBe(2)
    for (const card of cards) {
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1)
      expect(rect(card).right).toBeLessThanOrEqual(rect(list).right + 1)
      expect(rect(card).left).toBeGreaterThanOrEqual(rect(list).left - 1)
    }
  })

  /** A station name has no length limit Radio Browser enforces — one in the
   * wild ran to five wrapped lines, which is what dragged the old table
   * past its own columns. */
  it('keeps an absurd station name on one line instead of stretching the card', async () => {
    await openDiscover(390, [makeResult({ name: 'B'.repeat(120) })])

    const name = document.querySelector('.discover-card__name')!
    const card = document.querySelector('.discover-card')!
    expect(rect(name).width).toBeLessThanOrEqual(rect(card).width)
    // One line: a wrapped 120-character name would be several times this.
    expect(rect(name).height).toBeLessThan(40)
  })

  /** The list used to carry `max-height: 52vh` and its own overflow, which
   * boxed it into just over half the screen while the dialog around it was
   * full height — a long result set looked cut in half on a phone. The
   * dialog is `scrollable`, so its own v-card-text is the one scroll
   * region; the list must not be a second one.
   *
   * Only this half is asserted. Whether the *dialog* then scrolls cannot be
   * measured here: `vuetify/styles` carries no component rules at all (no
   * .v-dialog--scrollable, no fullscreen max-height — those come from
   * vite-plugin-vuetify, which vitest.browser.config.ts does not load), so
   * VDialog renders unstyled in this runner and would report "does not
   * scroll" no matter what the app does. */
  it('leaves the scrolling to the dialog instead of boxing the list', async () => {
    await openDiscover(
      390,
      Array.from({ length: 12 }, (_, i) => makeResult({ stationuuid: `u${i}` })),
    )

    const list = document.querySelector('.discover-results') as HTMLElement
    expect(list.scrollHeight).toBeLessThanOrEqual(list.clientHeight + 1)
    expect(getComputedStyle(list).maxHeight).toBe('none')
  })

  /** On the desktop the two figures sit beside the name; in the phone
   * shell they drop under it rather than squeezing the name out of its own
   * row.
   *
   * Driven by the `compact` prop the phone page passes, not by the
   * viewport: this used to be a media query, which made Radio the one
   * screen in the app deciding for itself what mobile meant. A narrow
   * desktop window is a narrow desktop window here now, like everywhere
   * else — hence the same 390px width in both halves below, with only the
   * prop differing. */
  it('moves the popularity figures below the name in the phone shell', async () => {
    await openDiscover(390, [makeResult()])
    const wideName = rect(document.querySelector('.discover-card__body')!)
    const wideStats = rect(document.querySelector('.discover-card__stats')!)
    expect(wideStats.left).toBeGreaterThan(wideName.right - 1)

    await openDiscover(390, [makeResult()], true)
    const narrowName = rect(document.querySelector('.discover-card__body')!)
    const narrowStats = rect(document.querySelector('.discover-card__stats')!)
    expect(narrowStats.top).toBeGreaterThanOrEqual(narrowName.bottom - 1)
  })

  /** The filter row is a search field, a country picker and a sort control
   * — side by side on the desktop, stacked in the phone shell. */
  it('stacks the filter row in the phone shell', async () => {
    await openDiscover(390, [makeResult()])
    expect(getComputedStyle(document.querySelector('.discover-filters')!).flexDirection).toBe('row')

    await openDiscover(390, [makeResult()], true)
    expect(getComputedStyle(document.querySelector('.discover-filters')!).flexDirection).toBe(
      'column',
    )
  })

  /** Touch has no hover to reveal the play overlay with, so it must already
   * be faintly visible rather than waiting for a tap that has by then
   * started something playing. */
  it('leaves the play overlay visible without hover', async () => {
    await openDiscover(390, [makeResult()])

    const overlay = document.querySelector('.discover-card__play')!
    const opacity = Number(getComputedStyle(overlay).opacity)
    // The desktop rule hides it outright (0) until :hover; under a coarse
    // pointer the media query lifts it. Either is correct depending on what
    // the runner emulates, but it must never be fully opaque and hide the
    // logo underneath.
    expect(opacity).toBeLessThan(1)
  })
})
