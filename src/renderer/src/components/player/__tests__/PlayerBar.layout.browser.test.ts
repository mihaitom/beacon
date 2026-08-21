// Real-browser layout regression tests for PlayerBar.vue's responsive
// row — run via `pnpm test:layout` (see vitest.browser.config.ts), not the
// default jsdom `pnpm test:unit` suite. jsdom never actually computes CSS
// Grid track sizing or fires ResizeObserver callbacks, so a jsdom test
// asserting on either would "pass" without checking anything real — and
// this specific layout has already broken in exactly that kind of
// invisible way several times while it was being built:
//  - a `minmax(0, 1fr)` on the *side* columns, on the theory that `fr`
//    tracks are what shrink first, turned out backwards — grid satisfies
//    non-flexible tracks in full before giving anything to a `fr` track,
//    so the side columns need to be non-flexible and the center column
//    needs to be the `fr` one for it to be what actually gives way.
//  - the center track's `auto` sizing, meant to size it off the seek bar's
//    own 600px cap, instead read SongWaveform.vue's `width: 100%` canvas
//    (percentages are excluded from max-content computation entirely per
//    spec) and settled on an arbitrary value with a real ResizeObserver
//    feedback loop behind it — replaced by a plain minmax(220px, 1fr).
//  - two side columns independently sized to their own content (`auto`
//    each) does stop them from ever shrinking, but song-info's fixed
//    300px and the toolbar's own natural width are almost never equal, so
//    control-container ended up measurably (~67px) off the bar's own
//    midpoint — replaced by a shared --player-bar-flank-width both sides
//    use identically (see PlayerBar.vue's flankWidthPx).
//  - the volume-collapse ResizeObserver watches .player-bar itself, which
//    must NOT carry the row's own min-width — that min-width belongs one
//    level down on .player-bar__row, or .player-bar's measured width can
//    never report anything narrower than the floor, and the observer that
//    exists specifically to avoid needing that floor never fires.
//  - control-container's own min-width (220px, CenterControls.vue's real
//    measured width) and the grid's own center-track minimum used to be
//    two independently-hardcoded numbers (220 vs a stale, unrelated 300)
//    that only happened to both "work" because the larger one silently
//    won — replaced by one --control-container-min-width custom property
//    both agree on.
//  - control-container was briefly given a fixed width (exactly matching
//    CenterControls.vue's own ~212px) so SeekBar.vue's width: 100% would
//    render pixel-identical to the transport buttons above it. That's real
//    CSS the browser will happily do, but it was chasing a constraint the
//    reference implementation this whole layout is modeled on (the
//    original, React-based Feishin) never actually enforces — its own
//    seek bar deliberately fills nearly the entire shared box while its
//    transport buttons stay narrower and centered independently within
//    it. control-container now does the same: it fills its whole grid
//    track (width: 100%), and only the *box* is centered in the bar, not
//    each row inside it individually — see ControlContainer.vue's own
//    comment for the full reasoning.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useConnectStore } from '@/stores/connect'
import PlayerBar from '../PlayerBar.vue'
import { makeSong, makeStatus } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

// Unmounted at the start of every mountBar() call, not just in afterEach —
// several tests below deliberately mount twice (once per viewport) to
// compare before/after; without this the *first* mount's elements stay
// attached to document.body too, and a bare document.querySelector() would
// silently keep measuring that stale (wrong-viewport) instance instead of
// the fresh one.
let currentWrapper: VueWrapper | null = null

async function mountBar(castingElectron = false) {
  if (currentWrapper) {
    currentWrapper.unmount()
    currentWrapper = null
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/artists/:id', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()
  setActivePinia(createPinia())
  usePlaybackStore().setQueue([makeSong('a', { title: 'Track', artist: 'Artist' })], 0)
  if (castingElectron) {
    window.api = {} as typeof window.api
    useConnectStore().status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
  }
  // Same reasoning as NowPlayingView.layout.browser.test.ts's own mount
  // helper — PlayerBar's <v-footer app> needs a real <v-app> layout
  // ancestor, and a wrapper component with an inline `template:` string
  // can't compile at runtime under vitest's browser mode (production Vue
  // ships without the template compiler) — h() sidesteps both.
  const wrapper = mount(
    { render: () => h(components.VApp, null, { default: () => h(PlayerBar) }) },
    {
      attachTo: document.body,
      global: { plugins: [vuetify, i18n, router] },
    },
  )
  currentWrapper = wrapper
  await wrapper.vm.$nextTick()
  // Lets the mounted() ResizeObserver's first callback land before
  // assertions run.
  await new Promise((resolve) => setTimeout(resolve, 100))
  return wrapper
}

function rect(selector: string): DOMRect {
  return (document.querySelector(selector) as HTMLElement).getBoundingClientRect()
}

describe('PlayerBar layout', () => {
  beforeEach(() => {
    window.api = undefined as unknown as typeof window.api
  })

  afterEach(() => {
    currentWrapper?.unmount()
    currentWrapper = null
    vi.restoreAllMocks()
  })

  it('centers control-container exactly, regardless of the two side columns differing in width', async () => {
    await page.viewport(1600, 400)
    await mountBar(true) // widest realistic toolbar (Electron + casting)

    const barRect = rect('.player-bar')
    const centerRect = rect('.control-container')

    expect(Math.round(rect('.song-info').width)).toBe(300)
    expect(
      Math.abs(barRect.left + barRect.width / 2 - (centerRect.left + centerRect.width / 2)),
    ).toBeLessThan(1)
  })

  it('stays exactly centered in the collapsed state too, where song-info (not the toolbar) is the wider flank', async () => {
    // Comfortably collapsed (well below VOLUME_COLLAPSE_BREAKPOINT_PX) but
    // still above .player-bar__row's own 852px collapsed floor + 32px
    // px-4 padding — right at/under that combined 884px is expected to
    // genuinely overflow instead of staying centered, see the dedicated
    // "refuses to shrink past its own floor" test below for that case.
    await page.viewport(1000, 400)
    await mountBar(false)

    const barRect = rect('.player-bar')
    const centerRect = rect('.control-container')
    expect(
      Math.abs(barRect.left + barRect.width / 2 - (centerRect.left + centerRect.width / 2)),
    ).toBeLessThan(1)
  })

  it('control-container fills its whole grid track — grows with the window, it does not stay pinned to center-controls own narrow content width', async () => {
    await page.viewport(1600, 400)
    await mountBar(false)
    const narrowerWidth = rect('.control-container').width

    await page.viewport(1300, 400) // still comfortably above the row's own floor, but narrower
    await mountBar(false)

    expect(rect('.control-container').width).toBeLessThan(narrowerWidth)
    // Fills exactly what's left of the row after both (identical) flanks
    // and the two 16px gaps — not some other, unrelated number.
    const rowRect = rect('.player-bar__row')
    expect(rect('.control-container').width).toBeCloseTo(rowRect.width - 2 * 434 - 2 * 16, 0)
  })

  describe('volume slider collapse', () => {
    it('stays inline above the collapse breakpoint', async () => {
      await page.viewport(1300, 400)
      await mountBar(false)

      expect(document.querySelector('.toolbar > .volume-slider')).not.toBeNull()
    })

    it('collapses into a popover below the breakpoint — control-container still fills its own grid track, using the narrower collapsed flank width', async () => {
      await page.viewport(950, 400)
      await mountBar(false)

      expect(document.querySelector('.toolbar > .volume-slider')).toBeNull()
      const rowRect = rect('.player-bar__row')
      expect(rect('.control-container').width).toBeCloseTo(rowRect.width - 2 * 300 - 2 * 16, 0)
    })

    it('the collapsed activator opens a popover with a working, functionally identical slider', async () => {
      await page.viewport(950, 400)
      const wrapper = await mountBar(false)
      const toolbar = document.querySelector('.toolbar') as HTMLElement
      const activator = Array.from(toolbar.querySelectorAll('button')).find((button) =>
        button.querySelector('.mdi-volume-high, .mdi-volume-mute'),
      ) as HTMLElement

      activator.click()
      await wrapper.vm.$nextTick()
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(document.querySelector('.volume-popover .volume-slider')).not.toBeNull()
    })
  })

  it('the row refuses to shrink past its own floor once the volume slider has already collapsed — .player-bar itself overflows instead of anything inside visibly breaking', async () => {
    await page.viewport(700, 400)
    await mountBar(true) // widest realistic *collapsed* toolbar

    const rowRect = rect('.player-bar__row')
    expect(rowRect.width).toBeGreaterThan(700)
    expect(Math.round(rect('.song-info').width)).toBe(300)
    expect(rect('.control-container').width).toBeGreaterThanOrEqual(220)
  })

  describe('center-controls / seek-bar within control-container', () => {
    it('control-container is never narrower than center-controls actually needs, at any width', async () => {
      for (const width of [1600, 1000, 700]) {
        await page.viewport(width, 400)
        await mountBar(false)

        expect(rect('.control-container').width).toBeGreaterThanOrEqual(
          rect('.center-controls').width,
        )
      }
    })

    it('center-controls stays horizontally centered within control-container at any width, not just the whole bar', async () => {
      for (const width of [1600, 1000, 700]) {
        await page.viewport(width, 400)
        await mountBar(false)

        const containerRect = rect('.control-container')
        const centerControlsRect = rect('.center-controls')
        expect(
          Math.abs(
            containerRect.left +
              containerRect.width / 2 -
              (centerControlsRect.left + centerControlsRect.width / 2),
          ),
        ).toBeLessThan(1)
      }
    })

    // control-container is now deliberately free to stretch to fill the
    // row's own leftover space (see ControlContainer.vue's own comment,
    // modeled on the original Feishin) — the invariant this guards isn't
    // "control-container stays small", it's that seek-bar's own width:
    // 100% always fills *however wide control-container actually is*, at
    // any window width, rather than silently capping out somewhere below
    // it (the old 600px max-width) or overflowing past it. Exact equality,
    // not just "greater than or equal to some floor" — that would still
    // pass even if seek-bar were narrower than control-container's own
    // box, which would visibly misalign it from center-controls above.
    it("seek-bar's own rendered width exactly matches control-container's, at any width — not just some shared floor", async () => {
      for (const width of [1600, 1000, 700]) {
        await page.viewport(width, 400)
        await mountBar(false)

        expect(rect('.seek-bar').width).toBe(rect('.control-container').width)
      }
    })

    it("seek-bar never renders narrower than control-container's own min-width, once the row itself is squeezed to its floor", async () => {
      await page.viewport(700, 400)
      await mountBar(true) // pins control-container right at its 220px floor

      expect(rect('.control-container').width).toBeCloseTo(220, 0)
      expect(rect('.seek-bar').width).toBeGreaterThanOrEqual(220)
    })
  })
})
