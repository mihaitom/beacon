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
//    CSS the browser will happily do, but a seek bar no wider than five
//    small icon buttons reads as broken rather than aligned, and costs
//    real precision on a control people aim at. control-container fills
//    its whole grid track (width: 100%) instead, with only the *box*
//    centered in the bar, not each row inside it individually — see
//    ControlContainer.vue's own comment for the full reasoning.
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

/** Puts a station with a long ICY tag on the bar instead of a song — the
 * shape that has the least room to work with: the tag arrives as one
 * "Artist - Title" string in the top line, with no artist line to split it
 * across. */
async function mountRadioBar(nowPlaying: string) {
  const wrapper = await mountBar()
  const playback = usePlaybackStore()
  playback.queue = []
  playback.currentIndex = -1
  playback.radioStation = {
    id: 'r1',
    name: 'Some Station',
    streamUrl: 'http://stream.test/live',
    homePageUrl: null,
  }
  playback.radioNowPlaying = nowPlaying
  await wrapper.vm.$nextTick()
  return wrapper
}

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

    // song-info fills its whole flank rather than sitting at a fixed width
    // inside it (see its own rule) — in this state that flank is the
    // toolbar's 434px, and the room goes to the title/artist instead of
    // being left empty. What has to stay true is that both flanks are
    // identical, which is what centers the middle track by construction.
    expect(Math.round(rect('.song-info').width)).toBe(434)
    expect(
      Math.abs(barRect.left + barRect.width / 2 - (centerRect.left + centerRect.width / 2)),
    ).toBeLessThan(1)
  })

  it('gives a radio station its whole flank to put an ICY tag in', async () => {
    // Which is the point of song-info filling its track: the tag is a
    // single line of text with no second line to spill onto, so every
    // pixel of the flank that used to sit unused beside a 300px-wide
    // song-info is a few more characters before it truncates.
    await page.viewport(1600, 400)
    // Long enough to have to be cut off either way — what is under test is
    // how much of it survives, not whether it fits.
    await mountRadioBar(
      'The Tide feat. Harbor Lights - Slow Return (Extended Club Mix, Remastered 2024)',
    )

    const info = rect('.song-info')
    const text = rect('.song-info .min-width-0')
    const title = document.querySelector('.song-info .min-width-0 > div') as HTMLElement

    expect(Math.round(info.width)).toBe(434)
    // Everything the cover and its margin leave — well past the ~240px the
    // same text had inside the old fixed 300px box.
    expect(text.width).toBeGreaterThan(360)
    expect(Math.round(text.right)).toBe(Math.round(info.right))
    // Still truncated (it is a very long tag), just later than it was.
    expect(title.scrollWidth).toBeGreaterThan(title.clientWidth)
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

  it('control-container fills its whole grid track below its own 600px ceiling — grows with the window, it does not stay pinned to center-controls own narrow content width', async () => {
    // Both widths below stay under the ~1468px row width that would push
    // control-container's own leftover-track share past its 600px ceiling
    // (see the dedicated cap test further down for that region instead) —
    // this one only covers the *uncapped* growth behavior.
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

    // control-container fills the row's own leftover grid-track space up to
    // its own 600px ceiling (see its own comment) — the invariant this
    // guards isn't "control-container stays small" or "control-container
    // stays unbounded", it's that seek-bar's own width: 100% always fills
    // *however wide control-container actually ends up being* — capped or
    // not — at any window width, rather than silently capping out
    // somewhere below it on its own (a max-width directly on SeekBar.vue
    // itself, tried once and reverted — see that file's own comment) or
    // overflowing past it. Exact equality, not just "greater than or equal
    // to some floor" — that would still pass even if seek-bar were
    // narrower than control-container's own box, which would visibly
    // misalign it from center-controls above. 2200 is comfortably past
    // control-container's own 600px ceiling, so this also proves the
    // equality holds *with* that ceiling engaged, not only in the
    // unbounded region below it.
    it("seek-bar's own rendered width exactly matches control-container's, at any width — not just some shared floor", async () => {
      for (const width of [2200, 1600, 1000, 700]) {
        await page.viewport(width, 400)
        await mountBar(false)

        expect(rect('.seek-bar').width).toBe(rect('.control-container').width)
      }
    })

    it("control-container's own width stays capped at 600px on a wide monitor, centered within its (wider) grid track rather than pinned to one side", async () => {
      await page.viewport(2200, 400)
      await mountBar(false)

      expect(rect('.control-container').width).toBeCloseTo(600, 0)
      const rowRect = rect('.player-bar__row')
      const containerRect = rect('.control-container')
      expect(
        Math.abs(rowRect.left + rowRect.width / 2 - (containerRect.left + containerRect.width / 2)),
      ).toBeLessThan(1)
    })

    it("seek-bar never renders narrower than control-container's own min-width, once the row itself is squeezed to its floor", async () => {
      await page.viewport(700, 400)
      await mountBar(true) // pins control-container right at its 220px floor

      expect(rect('.control-container').width).toBeCloseTo(220, 0)
      expect(rect('.seek-bar').width).toBeGreaterThanOrEqual(220)
    })
  })
})
