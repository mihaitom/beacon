// Real-browser layout tests for SettingsView.vue's panelled sections — run
// via `pnpm test:layout` (see vitest.browser.config.ts), not the default
// jsdom suite. The two things worth checking here are the two jsdom cannot
// answer at all: whether anything overflows a phone-width viewport, and
// whether the quality selects actually sit side by side when there is room
// and stack when there is not (flex-wrap resolution, which jsdom does not
// compute).
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
// Carries --beacon-hairline, which the panel and divider borders are drawn
// with. Without it those `border: 1px solid var(--beacon-hairline)`
// declarations are invalid at computed-value time and drop out whole, so
// every border measures 0px and the divider assertion below would pass no
// matter what the rule said.
import '@/assets/base.css'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { usePlaybackStore } from '@/stores/playback'
import SettingsView from '../SettingsView.vue'

const vuetify = createVuetify({ components, directives })

let currentWrapper: VueWrapper | null = null

async function mountSettings(width: number, height = 900) {
  if (currentWrapper) {
    currentWrapper.unmount()
    currentWrapper = null
  }
  await page.viewport(width, height)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  setActivePinia(createPinia())
  const auth = useAuthStore()
  auth.serverType = 'subsonic'
  auth.serverUrl = 'https://music.example.com'
  auth.username = 'someone'
  // Admin, so the sections that are capability-gated actually render and
  // get measured rather than being quietly absent.
  auth.isAdmin = true

  // h() rather than an inline template string: production Vue ships without
  // the runtime template compiler, same reason PlayerBar's own layout test
  // builds its wrapper this way.
  const wrapper = mount(
    { render: () => h(components.VApp, null, { default: () => h(SettingsView) }) },
    { attachTo: document.body, global: { plugins: [vuetify, i18n, router] } },
  )
  currentWrapper = wrapper
  await wrapper.vm.$nextTick()
  await new Promise((resolve) => setTimeout(resolve, 100))
  return wrapper
}

function rects(selector: string): DOMRect[] {
  return [...document.querySelectorAll(selector)].map((el) =>
    (el as HTMLElement).getBoundingClientRect(),
  )
}

describe('SettingsView layout', () => {
  afterEach(() => {
    currentWrapper?.unmount()
    currentWrapper = null
  })

  it('renders every section as its own panel', async () => {
    await mountSettings(1200)

    // Account, Playback, Library, Lyrics, Storage, Advanced, About.
    expect(rects('.beacon-panel').length).toBe(7)
  })

  it('fits a phone viewport without anything spilling sideways', async () => {
    await mountSettings(390, 800)

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
    for (const panel of rects('.beacon-panel')) {
      expect(panel.right).toBeLessThanOrEqual(390)
      expect(panel.left).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps the account row inside the panel on a phone', async () => {
    // Its badge, two lines of text and a logout button are what run out of
    // width first, well before the panel itself is tight.
    await mountSettings(390, 800)

    const [panel] = rects('.beacon-panel')
    const [strip] = rects('.account-strip')
    expect(strip!.right).toBeLessThanOrEqual(panel!.right + 1)
    expect(strip!.left).toBeGreaterThanOrEqual(panel!.left - 1)
  })

  /** The format select carries the actual decision and the bitrate is a
   * number that needs no room, so they share a line where there is one. */
  it('puts format and bitrate side by side with room, and stacks them without', async () => {
    // The bitrate select only exists for a format that has one — the
    // default is "original", which is a single-control row with nothing to
    // lay out against.
    await mountSettings(1200)
    usePlaybackStore().setLocalQuality('mp3')
    await currentWrapper!.vm.$nextTick()
    const wide = rects('.quality-row')[0]!
    const wideSelects = [...document.querySelectorAll('.quality-row')][0]!.children
    const first = (wideSelects[0] as HTMLElement).getBoundingClientRect()
    const second = (wideSelects[1] as HTMLElement).getBoundingClientRect()
    expect(second.left).toBeGreaterThan(first.right - 1)
    expect(Math.round(first.top)).toBe(Math.round(second.top))
    // The format select is the wider of the two.
    expect(first.width).toBeGreaterThan(second.width)
    expect(wide.width).toBeGreaterThan(0)

    await mountSettings(360, 800)
    usePlaybackStore().setLocalQuality('mp3')
    await currentWrapper!.vm.$nextTick()
    const narrowRow = [...document.querySelectorAll('.quality-row')][0]!.children
    const narrowFirst = (narrowRow[0] as HTMLElement).getBoundingClientRect()
    const narrowSecond = (narrowRow[1] as HTMLElement).getBoundingClientRect()
    expect(narrowSecond.top).toBeGreaterThan(narrowFirst.top)
  })

  /** The separator is what gives the page its rhythm; it must appear
   * between two blocks and never above the topmost one in a panel.
   *
   * "Block", not "setting": the account panel opens with the account strip,
   * which is not a .setting, and the setting under it is a second block
   * however the markup names it. Reading this as "never above the first
   * .setting" is what left account and language sharing an edge — the one
   * place in the page where the rhythm visibly broke. */
  it('draws a divider between blocks but never above the topmost in a panel', async () => {
    await mountSettings(1200)
    const panels = [...document.querySelectorAll('.beacon-panel')]

    for (const panel of panels) {
      const settings = [...panel.querySelectorAll(':scope > .setting')]
      const isTopmost = panel.firstElementChild === settings[0]
      expect(getComputedStyle(settings[0]!).borderTopWidth).toBe(isTopmost ? '0px' : '1px')
      for (const later of settings.slice(1)) {
        expect(getComputedStyle(later).borderTopWidth).toBe('1px')
      }
    }

    // Guards this guard too: the exception is only worth spelling out if a
    // panel actually opens with something that is not a .setting.
    expect(
      panels.some((panel) => panel.firstElementChild !== panel.querySelector(':scope > .setting')),
    ).toBe(true)

    // Guards the guard: a panel holding a single setting could never fail
    // the "between" half above, so at least one must actually have
    // siblings for this to be measuring anything.
    const withSiblings = panels.filter(
      (panel) => panel.querySelectorAll(':scope > .setting').length > 1,
    )
    expect(withSiblings.length).toBeGreaterThan(0)
  })
})
