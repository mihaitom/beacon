// Real-browser layout regression tests for NowPlayingView's responsive
// artwork/lyrics arrangement — run via `pnpm test:layout` (see
// vitest.browser.config.ts), not the default jsdom `pnpm test:unit` suite.
// jsdom never actually computes container queries, clamp(), or the
// flip-card's 3D transform, so a jsdom test asserting on any of those would
// "pass" without checking anything real. This file locks in the three
// shapes NowPlayingView.vue's CSS comments describe handling:
//  - a wide desktop window: artwork and lyrics side by side
//  - a portrait/narrow monitor: the artwork+info card flips to show lyrics
//    on its back face instead of squeezing a side-by-side row
//  - mobile (the `compact` prop): always flipped, regardless of aspect
//    ratio, in a much smaller box
//  - both sides of the flip boundary itself, and the thing that boundary
//    exists to prevent: artwork and lyrics wrapping into two stacked rows
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
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useDrawersStore } from '@/stores/drawers'
import { useLyricsStore } from '@/stores/lyrics'
import NowPlayingView from '../NowPlayingView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/artists/:id', component: { template: '<div />' } },
      { path: '/albums/:id', component: { template: '<div />' } },
    ],
  })
}

// Unmounted in afterEach — attachTo: document.body is what makes real
// layout (container queries, viewport-relative sizing) meaningful at all,
// but that also means each mount leaves real nodes in the shared document
// unless something cleans them up between tests.
const mountedWrappers: VueWrapper[] = []

async function mountView(props: Record<string, unknown> = {}) {
  const router = makeRouter()
  await router.push('/')
  await router.isReady()
  // No <v-app> wrapper — NowPlayingView itself never uses an `app`-mode
  // Vuetify component (v-app-bar/v-footer/...) that would need one's
  // layout injection (unlike PlayerBar.vue's <v-footer app>, see its own
  // component test). Mounting the real SFC directly also sidesteps
  // needing an inline `template:` string on a wrapper component, which
  // vitest's browser mode can't compile at runtime (production Vue builds
  // ship without the template compiler — only real .vue files, already
  // precompiled by @vitejs/plugin-vue, work here).
  const wrapper = mount(NowPlayingView, {
    props,
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n, router],
      // AudioVisualizer needs a real audio source (Web Audio analyser)
      // this test has none of — kept out regardless of showVisualizer
      // (see beforeEach) as a second line of defense against it ever
      // mounting and throwing.
      stubs: { AudioVisualizer: true },
    },
  })
  mountedWrappers.push(wrapper)
  return { wrapper, router }
}

// Real lyrics text (not the store's own fetch — that would hit a live
// backend) long enough to actually wrap across a few lines, so the lyrics
// panel's rendered geometry reflects real content instead of an empty box.
const LYRIC_LINES = [
  { time: 0, text: "Some place I've never been before" },
  { time: 4, text: 'Chasing a light past the harbor door' },
  { time: 8, text: 'Every wave carries what the tide once knew' },
  { time: 12, text: "And I'm still finding my way back to you" },
]

async function mountWithSongAndLyrics(compact = false) {
  const mounted = await mountView({ compact })
  const playback = usePlaybackStore()
  const drawers = useDrawersStore()
  playback.setQueue(
    [makeSong('a', { title: 'Harbor Lights', artist: 'The Tide', album: 'Slow Return' })],
    0,
  )
  const lyrics = useLyricsStore()
  vi.spyOn(lyrics, 'ensureLoaded').mockResolvedValue()
  lyrics.synced = true
  lyrics.lines = LYRIC_LINES
  drawers.lyricsDrawerOpen = true
  await mounted.wrapper.vm.$nextTick()
  return mounted
}

function rect(el: Element): DOMRect {
  return el.getBoundingClientRect()
}

describe('NowPlayingView layout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Keeps .now-playing__stage's own height exactly the viewport height
    // for every test below — otherwise the visualizer row (auto-shown by
    // default, see readShowVisualizer()) eats a real 128px/64px slice of
    // it, and every artSize/clamp() expectation below would have to guess
    // around that instead of reasoning about the plain viewport.
    localStorage.setItem('beacon.showVisualizer', 'false')
  })

  afterEach(() => {
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('goes side by side on a wide desktop window, both panels fully on-screen', async () => {
    await page.viewport(1920, 1080)
    const { wrapper } = await mountWithSongAndLyrics()

    const content = wrapper.get('.now-playing__content')
    expect(content.classes()).toContain('now-playing__content--split')

    // The portrait/mobile flip only ever applies inside the container
    // query or .now-playing--compact — neither is active here, so the
    // flip-card stays `display: contents` (no box, no transform) and the
    // two faces lay out as plain side-by-side flex children instead.
    const flipCard = wrapper.get('.now-playing__flip-card').element
    expect(getComputedStyle(flipCard).transform).toBe('none')

    const artwork = rect(wrapper.get('.now-playing__primary').element)
    const lyrics = rect(wrapper.get('.now-playing__lyrics').element)
    // Side by side, not stacked or overlapping.
    expect(lyrics.left).toBeGreaterThanOrEqual(artwork.right - 1)
    // Lyrics panel's own contract: min(38cqw, 560px) — at 1920px wide,
    // 38cqw alone would be ~730px, so this is really asserting the 560px
    // ceiling actually caps it rather than growing unbounded.
    expect(lyrics.width).toBeGreaterThan(400)
    expect(lyrics.width).toBeLessThanOrEqual(562)
    // Artwork's own contract: clamp(180px, ..., 900px) — a big monitor
    // should land well above the floor.
    const art = rect(wrapper.get('.now-playing__art-wrap').element)
    expect(art.width).toBeGreaterThan(400)
    expect(art.width).toBeLessThanOrEqual(900)

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1921)

    const lines = wrapper.findAll('.lyrics-panel__line')
    expect(lines.length).toBe(LYRIC_LINES.length)
  })

  it('flips the artwork card to show lyrics on a portrait monitor, no horizontal overflow', async () => {
    await page.viewport(1080, 1920)
    const { wrapper } = await mountWithSongAndLyrics()

    const flipCard = wrapper.get('.now-playing__flip-card').element
    // A real, non-identity 3D transform — the portrait container query's
    // rotateY(180deg) rule fired, i.e. the card actually flipped instead
    // of falling back to (or silently staying in) the side-by-side layout,
    // which would badly cramp a ~4:7 aspect stage.
    expect(getComputedStyle(flipCard).transform).not.toBe('none')

    // The back face (lyrics) is absolutely positioned to exactly cover the
    // same box the front face (artwork) occupies — not a smaller inset
    // panel floating inside it, not something wider than it.
    const cardRect = rect(flipCard)
    const lyricsRect = rect(wrapper.get('.now-playing__lyrics').element)
    expect(Math.abs(lyricsRect.width - cardRect.width)).toBeLessThan(2)
    expect(Math.abs(lyricsRect.height - cardRect.height)).toBeLessThan(2)

    const art = rect(wrapper.get('.now-playing__art-wrap').element)
    expect(art.width).toBeGreaterThanOrEqual(180)
    expect(art.width).toBeLessThanOrEqual(900)
    expect(art.right).toBeLessThanOrEqual(1080 + 1)

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1081)
  })

  describe('the side-by-side/flip boundary', () => {
    /** True while the flip-card is a real rotating box (the container query
     * matched) rather than `display: contents` (side-by-side). */
    function isFlipped(wrapper: VueWrapper): boolean {
      return getComputedStyle(wrapper.get('.now-playing__flip-card').element).transform !== 'none'
    }

    /** The state the flip exists to avoid: both panels still laid out as a
     * row, but wrapped onto two lines, each squeezed and competing for the
     * same width. */
    function isWrapped(wrapper: VueWrapper): boolean {
      const primary = rect(wrapper.get('.now-playing__primary').element)
      const lyrics = rect(wrapper.get('.now-playing__lyrics').element)
      return lyrics.top > primary.bottom - 1
    }

    it('flips a 1400x1080 window, which used to wrap into two cramped rows', async () => {
      // The reported case. Aspect ratio 1.30 is nowhere near the old
      // portrait-only 4/5 cutoff, so the flip never engaged and the
      // flex-wrap safety net took over instead.
      await page.viewport(1400, 1080)
      const { wrapper } = await mountWithSongAndLyrics()

      expect(isFlipped(wrapper)).toBe(true)
      expect(isWrapped(wrapper)).toBe(false)
    })

    it('stays side by side at 1600x1080, where both panels genuinely still fit', async () => {
      // The other side of the same boundary — a trigger that fires here
      // would be throwing away a layout that has ~60px of room to spare.
      await page.viewport(1600, 1080)
      const { wrapper } = await mountWithSongAndLyrics()

      expect(isFlipped(wrapper)).toBe(false)
      const primary = rect(wrapper.get('.now-playing__primary').element)
      const lyrics = rect(wrapper.get('.now-playing__lyrics').element)
      expect(lyrics.left).toBeGreaterThanOrEqual(primary.right - 1)
    })

    it('stays side by side on a short, wide 1500x900 window despite being under 1560px', async () => {
      // The aspect-ratio half of the condition: a flat container caps the
      // artwork at 70cqh (630px here) long before width becomes the
      // constraint, so there is still room for both.
      await page.viewport(1500, 900)
      const { wrapper } = await mountWithSongAndLyrics()

      expect(isFlipped(wrapper)).toBe(false)
      expect(isWrapped(wrapper)).toBe(false)
    })

    it('never leaves the two panels wrapped onto two rows, at any common window size', async () => {
      // The actual contract, rather than a list of remembered breakpoints:
      // every size below either fits side by side or flips, never wraps.
      // Both the width- and height-driven artwork regimes are represented
      // (see artSize's min(70cqh, 50cqw)).
      const sizes: [number, number][] = [
        [1920, 1080],
        [1600, 1440],
        [1500, 1080],
        [1400, 900],
        [1350, 900],
        [1200, 1080],
        [1100, 1440],
      ]
      for (const [width, height] of sizes) {
        await page.viewport(width, height)
        const { wrapper } = await mountWithSongAndLyrics()

        expect(isWrapped(wrapper), `${width}x${height} wrapped into two rows`).toBe(false)
        expect(
          document.documentElement.scrollWidth,
          `${width}x${height} overflowed horizontally`,
        ).toBeLessThanOrEqual(width + 1)
        wrapper.unmount()
        mountedWrappers.pop()
      }
    })
  })

  it('always flips on mobile (compact), fits a phone width, and stacks the toolbar', async () => {
    await page.viewport(390, 844)
    const { wrapper } = await mountWithSongAndLyrics(true)

    expect(wrapper.classes()).toContain('now-playing--compact')

    const flipCard = wrapper.get('.now-playing__flip-card').element
    expect(getComputedStyle(flipCard).transform).not.toBe('none')

    // Compact's own tighter contract: clamp(120px, ..., 320px) — a phone
    // screen should never let this grow to desktop sizes.
    const art = rect(wrapper.get('.now-playing__art-wrap').element)
    expect(art.width).toBeGreaterThanOrEqual(120)
    expect(art.width).toBeLessThanOrEqual(320)
    expect(art.right).toBeLessThanOrEqual(390 + 1)

    // The toolbar (visualizer/fullscreen-equivalent buttons) stacks
    // vertically on compact — two icon buttons side by side reached into
    // the artwork underneath at phone width (see the CSS comment).
    const toolbar = wrapper.get('.now-playing__toolbar').element
    expect(getComputedStyle(toolbar).flexDirection).toBe('column')

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(391)
  })
})
