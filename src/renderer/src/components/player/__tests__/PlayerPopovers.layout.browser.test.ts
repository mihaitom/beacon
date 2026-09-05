// Real-browser layout test for the two popovers that open off the player
// bar (PlayerToolbar.vue's collapsed volume slider, ConnectButton.vue's
// device picker) — run via `pnpm test:layout`, not the default jsdom
// suite, since what's being checked here is where a fixed-position,
// teleported overlay actually lands against the viewport. jsdom computes
// none of that: it would report zeros whether the rule applied or not.
//
// Kept out of PlayerBar.layout.browser.test.ts deliberately: the rule
// under test lives in assets/base.css, which also carries the app's global
// reset — importing that into the existing file would re-calibrate every
// measurement in it.
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
// Same order as main.ts: the app's own stylesheet first, which is what
// makes base.css's @layer declaration the authoritative one. Reversed,
// @layer base lands behind Vuetify's utility layer and its `* { margin: 0 }`
// reset silently cancels every mb-*/pa-* in the markup under test.
import '@/assets/main.css'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import PlayerBar from '../PlayerBar.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

/** Both popovers are pinned this far from the viewport's right edge, and
 * this far above the player bar (its own 88px plus the same gap) — see
 * .beacon-player-popover in assets/base.css. */
const GAP = 8
const PLAYER_BAR_HEIGHT = 88

let currentWrapper: VueWrapper | null = null

async function mountBar() {
  currentWrapper?.unmount()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  setActivePinia(createPinia())
  usePlaybackStore().setQueue([makeSong('a', { title: 'Track', artist: 'Artist' })], 0)
  // Same h() mount as PlayerBar.layout.browser.test.ts — <v-footer app>
  // needs a real <v-app> ancestor, and runtime template compilation isn't
  // available in browser mode.
  const wrapper = mount(
    { render: () => h(components.VApp, null, { default: () => h(PlayerBar) }) },
    { attachTo: document.body, global: { plugins: [vuetify, i18n, router] } },
  )
  currentWrapper = wrapper
  await wrapper.vm.$nextTick()
  // Lets PlayerBar's own ResizeObserver settle the collapsed state first.
  await new Promise((resolve) => setTimeout(resolve, 100))
  return wrapper
}

/** Clicks the icon button carrying `icon` and waits out the menu's open
 * transition, then measures the popover it opened. */
async function openPopover(icon: string): Promise<DOMRect> {
  document.querySelector(`.${icon}`)!.closest('button')!.click()
  await new Promise((resolve) => setTimeout(resolve, 300))
  const content = document.querySelector('.beacon-player-popover')
  if (!content) throw new Error(`no popover opened for .${icon}`)
  return content.getBoundingClientRect()
}

describe('player bar popovers', () => {
  afterEach(() => {
    currentWrapper?.unmount()
    currentWrapper = null
  })

  it('pins the cast picker to the bottom-right corner, clear of the bar', async () => {
    await page.viewport(1400, 800)
    await mountBar()

    const popover = await openPopover('mdi-cast')

    expect(Math.round(window.innerWidth - popover.right)).toBe(GAP)
    expect(Math.round(window.innerHeight - popover.bottom)).toBe(PLAYER_BAR_HEIGHT + GAP)
  })

  it('puts the volume popover in that exact same corner, not off its own button', async () => {
    // Narrow enough for the toolbar to fold the volume slider into a
    // popover at all (see PlayerBar.vue's volumeCollapsed).
    await page.viewport(1000, 800)
    await mountBar()

    const volume = await openPopover('mdi-volume-high')
    // Regression test for what pinning is for: anchored to their own
    // activators, these two landed a button-width apart, and moved
    // sideways as neighbouring icons came and went.
    document.querySelector('.v-overlay-container .v-overlay')?.remove()
    await mountBar()
    const cast = await openPopover('mdi-cast')

    expect(Math.round(volume.right)).toBe(Math.round(cast.right))
    expect(Math.round(volume.bottom)).toBe(Math.round(cast.bottom))
  })

  it('stays inside a short window instead of running off the top of it', async () => {
    // The static location strategy does no viewport-fitting of its own —
    // the max-height in base.css is what keeps a long device list on
    // screen.
    await page.viewport(1400, 400)
    await mountBar()

    const popover = await openPopover('mdi-cast')

    expect(popover.top).toBeGreaterThanOrEqual(0)
    expect(popover.height).toBeLessThanOrEqual(400 - PLAYER_BAR_HEIGHT - 2 * GAP)
  })
})
