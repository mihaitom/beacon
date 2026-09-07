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
  drawers.lyricsPanelOpen = true
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

    /** The same contract *during* a resize, not only after one. Widening a
     * window out of the flip state used to show the two panels stacked for
     * a sixth of a second before they snapped side by side - reported live
     * 2026-09-07, and measured in this harness at 168ms.
     *
     * The cause was max-width being a transitioned property on
     * .now-playing__content: a container query ceasing to match changes it
     * like anything else, so the row grew 1000px -> 1800px over the full
     * 0.45s while both panels were already back in flow needing ~1340px
     * between them, and flex-wrap (there as a safety net for genuinely
     * narrow containers) did exactly what it is for. Sampling every frame
     * is the point - the end state was correct the whole time, which is
     * why the existing tests above never saw it. */
    /** The flip card is as tall as the stage, not as tall as its own
     * contents. Only the artwork is sized by artSize(); the back face - the
     * lyrics, or a station's title log, a list that can always show more -
     * is sized to this box, and the rest of the height was going unused.
     * Measured before this: 708px of a 1000px stage at 1200x1000. The
     * phone had the same problem and was fixed first; this is the same
     * change on the window that flips. */
    it('gives the flipped card the whole stage height', async () => {
      await page.viewport(1200, 1000)
      const { wrapper } = await mountWithSongAndLyrics()

      const card = rect(wrapper.get('.now-playing__flip-card').element)
      const stage = rect(wrapper.get('.now-playing__stage').element)
      const content = getComputedStyle(wrapper.get('.now-playing__content').element)
      const padY = parseFloat(content.paddingTop) + parseFloat(content.paddingBottom)

      // Actually flipped at this size, or this measures the wrong thing.
      expect(getComputedStyle(wrapper.get('.now-playing__flip-card').element).display).not.toBe(
        'contents',
      )
      expect(card.height).toBeCloseTo(stage.height - padY, -0.5)

      // And the front face still reads as it did: artwork and title
      // centred in the taller box rather than pinned to its top.
      const art = rect(wrapper.get('.now-playing__art-wrap').element)
      const info = rect(wrapper.get('.now-playing__info').element)
      expect(Math.abs(art.top - stage.top - (stage.bottom - info.bottom))).toBeLessThan(24)
    })

    it('never stacks the panels while a window is being widened out of the flip', async () => {
      await page.viewport(900, 1000)
      const { wrapper } = await mountWithSongAndLyrics()
      // Settled in the flip state before the resize under test.
      await new Promise((resolve) => setTimeout(resolve, 300))

      await page.viewport(1920, 1080)
      // Well past the 0.45s the gap/max-width transitions run for.
      const deadline = performance.now() + 600
      const stackedAt: number[] = []
      const started = performance.now()
      while (performance.now() < deadline) {
        if (isWrapped(wrapper)) stackedAt.push(Math.round(performance.now() - started))
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      }

      expect(stackedAt, `stacked at ${stackedAt.join('ms, ')}ms after widening`).toEqual([])
    })

    /** The artwork column has to *slide* across the boundary, not teleport.
     *
     * Toggling lyrics with the button gets that for free: the panel's own
     * width animates up from 0, so the row re-centres a little further left
     * every frame. Crossing the boundary by resizing has no in-between -
     * the panel switches between an absolutely positioned back face and a
     * full-width flex child, and `position` cannot be animated - so the
     * column used to land ~270px away in a single frame.
     *
     * Dragged in small steps rather than resized in one jump, which is both
     * what a pointer does and what makes the assertion mean anything: over
     * 20px of window the column's own travel is a few pixels, so a large
     * step can only be the crossing. Measured at the crossing: ~271px
     * without the slide, ~39px with it (the animation's own travel between
     * two samples). */
    it('slides the artwork across the flip boundary instead of jumping it', async () => {
      await page.viewport(1440, 1000)
      const { wrapper } = await mountWithSongAndLyrics()
      await new Promise((resolve) => setTimeout(resolve, 300))

      const flipped = (): boolean =>
        getComputedStyle(wrapper.get('.now-playing__flip-card').element).display !== 'contents'

      /** How far the column moved on the one step that crossed the
       * boundary. Not the largest step of the whole drag: the steps after
       * it carry the slide still easing off, which is real movement and
       * lands in the same range, so the largest one was as often that as
       * it was the crossing. */
      async function crossingStep(from: number, to: number, by: number): Promise<number> {
        let previous: number | null = null
        let wasFlipped: boolean | null = null
        let atCrossing: number | null = null
        for (let width = from; by > 0 ? width <= to : width >= to; width += by) {
          await page.viewport(width, 1000)
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
          const left = rect(wrapper.get('.now-playing__primary').element).left
          const nowFlipped = flipped()
          if (previous !== null && wasFlipped !== null && nowFlipped !== wasFlipped) {
            atCrossing = Math.abs(left - previous)
          }
          previous = left
          wasFlipped = nowFlipped
        }
        if (atCrossing === null) throw new Error('the drag never crossed the boundary')
        return atCrossing
      }

      expect(flipped(), 'the drag has to start on the flip side of the boundary').toBe(true)
      // Measured at the crossing: ~271px without the slide, ~10px with it,
      // which is the 20px of window that step moved and nothing else.
      const widening = await crossingStep(1440, 1640, 20)
      expect(flipped()).toBe(false)
      expect(widening, `artwork jumped ${Math.round(widening)}px while widening`).toBeLessThan(60)

      await new Promise((resolve) => setTimeout(resolve, 600))
      const narrowing = await crossingStep(1640, 1440, -20)
      expect(flipped()).toBe(true)
      expect(narrowing, `artwork jumped ${Math.round(narrowing)}px while narrowing`).toBeLessThan(
        60,
      )
    })
  })

  // The title line is not always a song title: a radio station's ICY tag
  // lands there too, and some stations send far more than "Artist - Track"
  // (see connect/core/icy_metadata.py's clean_stream_title). Reported live
  // at five lines, with the artwork pushed half out of view - the info
  // block's height is what artSize leaves the artwork the rest of.
  describe('a very long radio title', () => {
    const LONG_TITLE =
      'Fun. - text="We Are Young" song_spot="M" MediaBaseId="1827386" ' +
      'itunesTrackId="0" amgTrackId="-1" amgArtistId="0" TAID="414211" ' +
      'TPID="16978031" cartcutId="0709588001" length="00:03:51"'

    async function mountWithRadioTitle(compact = false) {
      const mounted = await mountView({ compact })
      const playback = usePlaybackStore()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      playback.radioNowPlaying = LONG_TITLE
      await mounted.wrapper.vm.$nextTick()
      return mounted
    }

    it('clamps to three lines instead of growing down the page', async () => {
      await page.viewport(1920, 1080)
      const { wrapper } = await mountWithRadioTitle()

      const title = wrapper.get('.now-playing__title').element
      const style = getComputedStyle(title)
      const lineHeight = parseFloat(style.lineHeight)
      // The rendered box, not the property: -webkit-line-clamp only takes
      // effect together with -webkit-box display, and reading the property
      // back would pass even with that missing.
      expect(rect(title).height).toBeLessThanOrEqual(lineHeight * 3 + 1)
      // ...and it really is the clamp doing it, not a title that happened
      // to fit: the unclamped text is taller than the box showing it.
      expect(title.scrollHeight).toBeGreaterThan(rect(title).height)
    })

    it('leaves the artwork its room, rather than pushing it off the stage', async () => {
      await page.viewport(1920, 1080)
      const { wrapper } = await mountWithRadioTitle()

      const stage = rect(wrapper.get('.now-playing__stage').element)
      const art = rect(wrapper.get('.now-playing__art-wrap').element)
      expect(art.top).toBeGreaterThanOrEqual(stage.top - 1)
      expect(art.bottom).toBeLessThanOrEqual(stage.bottom + 1)
    })

    it('clamps to two lines in the compact (phone) layout', async () => {
      await page.viewport(390, 844)
      const { wrapper } = await mountWithRadioTitle(true)

      const title = wrapper.get('.now-playing__title').element
      const lineHeight = parseFloat(getComputedStyle(title).lineHeight)
      expect(rect(title).height).toBeLessThanOrEqual(lineHeight * 2 + 1)
      expect(title.scrollHeight).toBeGreaterThan(rect(title).height)
    })
  })

  it('always flips on mobile (compact) and fits a phone width', async () => {
    await page.viewport(390, 844)
    const { wrapper } = await mountWithSongAndLyrics(true)

    expect(wrapper.classes()).toContain('now-playing--compact')

    const flipCard = wrapper.get('.now-playing__flip-card').element
    expect(getComputedStyle(flipCard).transform).not.toBe('none')

    // Compact's own contract: never smaller than the clamp floor, never
    // wider than the screen. How *close* to the screen it should get is
    // NowPlayingView.compact.layout.browser.test.ts's subject, measured
    // against the room actually available rather than against a number.
    //
    // The floor is 88px, not the 120px it used to be: a phone on its side
    // leaves the stage under 200px, and a 120px minimum was taller than
    // such a stage could spare once the title block below the artwork was
    // counted (see artSize). This view is mounted on its own here, so its
    // stage has no height at all and the floor is the only thing sizing
    // the artwork — which is exactly what this line is pinning down.
    const art = rect(wrapper.get('.now-playing__art-wrap').element)
    expect(art.width).toBeGreaterThanOrEqual(88)
    expect(art.right).toBeLessThanOrEqual(390 + 1)

    // The toolbar used to be checked here for stacking vertically, back
    // when it floated in the artwork's top-right corner and two buttons
    // side by side reached into it. It is teleported into the app bar now
    // and is no part of this view's own box — see the compact layout test
    // for where it ends up instead.

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(391)
  })
})
