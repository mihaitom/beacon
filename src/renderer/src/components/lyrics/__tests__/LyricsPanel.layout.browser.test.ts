// Real-browser layout test for the lyrics panel's edge mask — run via
// `pnpm test:layout`, not the default jsdom suite. What's being checked is
// where content sits relative to a mask-image's fade zone, which jsdom
// computes none of: it reports zero-sized boxes and ignores mask-image
// entirely, so a jsdom version of this would pass no matter what.
//
// The bug it pins: unsynced (plain-text) lyrics start at the very top of
// the scroll container, which is where the mask is still fading in, so the
// first line rendered permanently half-transparent. Reported live
// 2026-08-25 as "the first line is always already half transparent".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useDrawersStore } from '@/stores/drawers'
import { useLyricsStore } from '@/stores/lyrics'
import NowPlayingView from '@/views/NowPlayingView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

/** Matches --lyrics-mask-fade in LyricsPanel.vue: the top and bottom
 * fraction of the scroll container the edge mask fades across. */
const MASK_FADE = 0.15

const wrappers: VueWrapper[] = []

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

async function mountPanel(synced: boolean, lineCount = 12, positionSeconds = 0) {
  // Mounted inside NowPlayingView rather than on a bare host div: the
  // panel is `height: 100%` over a flex chain, and its pads are
  // percentages of the scroll container, so it only measures anything
  // meaningful inside a host that actually gives it a height the way the
  // real app does.
  const wrapper = mount(NowPlayingView, {
    attachTo: document.body,
    global: { plugins: [vuetify, i18n, makeRouter()], stubs: { AudioVisualizer: true } },
  })
  wrappers.push(wrapper)
  const playback = usePlaybackStore()
  const drawers = useDrawersStore()
  playback.setQueue([makeSong('a', { title: 'Harbor Lights', artist: 'The Tide' })], 0)
  // Set before the lines arrive: that is the real sequence — playback is
  // already somewhere in the song when the lyrics finish loading.
  playback.localPosition = positionSeconds
  const lyrics = useLyricsStore()
  vi.spyOn(lyrics, 'ensureLoaded').mockResolvedValue()
  lyrics.synced = synced
  lyrics.lines = Array.from({ length: lineCount }, (_, i) => ({
    time: i * 4,
    text: `Line ${i + 1}`,
  }))
  drawers.lyricsDrawerOpen = true
  await wrapper.vm.$nextTick()
  await new Promise((resolve) => setTimeout(resolve, 150))
  return wrapper
}

/** Sub-pixel slack for comparing two independently rounded layout numbers
 * (a measured element edge against a computed fraction of a height). The
 * bug this file exists for was an overlap of ~50px, not a hundredth. */
const SUBPIXEL = 0.5

/** How far the first rendered line starts below the top of the scrolling
 * box, in the box's own pixels. */
function firstLineOffset(): { offset: number; fadeEndsAt: number } {
  const scroll = document.querySelector('.lyrics-panel__scroll') as HTMLElement
  const line = document.querySelector('.lyrics-panel__line') as HTMLElement
  const scrollRect = scroll.getBoundingClientRect()
  return {
    offset: line.getBoundingClientRect().top - scrollRect.top,
    fadeEndsAt: scrollRect.height * MASK_FADE,
  }
}

describe('LyricsPanel edge mask', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Keeps the stage (and with it the lyrics panel) at full height — the
    // visualizer row would otherwise eat a slice of every measurement here.
    localStorage.setItem('beacon.showVisualizer', 'false')
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('starts unsynced lyrics below the fade, not inside it', async () => {
    await page.viewport(1200, 800)
    await mountPanel(false)

    const { offset, fadeEndsAt } = firstLineOffset()
    // Regression: this used to be exactly 0 — the first line began where
    // the mask was still near-transparent.
    expect(offset).toBeGreaterThanOrEqual(fadeEndsAt - SUBPIXEL)
  })

  it('leaves the last unsynced line clear of the bottom fade too', async () => {
    await page.viewport(1200, 800)
    await mountPanel(false)

    const scroll = document.querySelector('.lyrics-panel__scroll') as HTMLElement
    const pads = document.querySelectorAll('.lyrics-panel__mask-pad')
    expect(pads).toHaveLength(2)
    // Same depth at both ends, matching the mask's own symmetry.
    for (const pad of pads) {
      expect(pad.getBoundingClientRect().height).toBeCloseTo(
        scroll.getBoundingClientRect().height * MASK_FADE,
        0,
      )
    }
  })

  it('centers a short unsynced set instead of parking it at the top', async () => {
    await page.viewport(1200, 800)
    await mountPanel(false, 3)

    const scroll = document.querySelector('.lyrics-panel__scroll') as HTMLElement
    const text = document.querySelector('.lyrics-panel__line--plain') as HTMLElement
    const scrollRect = scroll.getBoundingClientRect()
    const textRect = text.getBoundingClientRect()

    // Nothing to scroll — a few lines pinned to the top of a tall panel
    // read as though the rest had been cut off.
    expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.clientHeight + 1)
    const scrollMid = scrollRect.top + scrollRect.height / 2
    const textMid = textRect.top + textRect.height / 2
    expect(Math.abs(textMid - scrollMid)).toBeLessThan(2)
  })

  it('falls back to top-aligned once an unsynced set is long enough to scroll', async () => {
    // `safe center` matters here: plain centering would push the start of
    // an overflowing set above the scrollport, where it can never be
    // scrolled back into view.
    await page.viewport(1200, 800)
    await mountPanel(false, 60)

    const scroll = document.querySelector('.lyrics-panel__scroll') as HTMLElement
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight)
    expect(scroll.scrollTop).toBe(0)

    const { offset, fadeEndsAt } = firstLineOffset()
    // Still clear of the fade at the top, exactly as in the short case.
    expect(offset).toBeGreaterThanOrEqual(fadeEndsAt - SUBPIXEL)

    // ...and scrolled all the way down, the last line clears the bottom
    // fade the same way — the pad is part of the scrolled content, so it
    // survives being scrolled to the end rather than only padding the
    // initial view.
    scroll.scrollTop = scroll.scrollHeight
    await new Promise((resolve) => setTimeout(resolve, 50))
    const scrollRect = scroll.getBoundingClientRect()
    const text = document.querySelector('.lyrics-panel__line--plain') as HTMLElement
    expect(text.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      scrollRect.bottom - fadeEndsAt + SUBPIXEL,
    )
  })

  it('synced lyrics were already clear of it, via their own centering pads', async () => {
    // The other half of the contract — whatever is done for the plain view
    // must not be needed twice, or start pushing the synced list around.
    await page.viewport(1200, 800)
    await mountPanel(true)

    const { offset, fadeEndsAt } = firstLineOffset()
    expect(offset).toBeGreaterThan(fadeEndsAt)
    expect(document.querySelectorAll('.lyrics-panel__mask-pad')).toHaveLength(0)
  })
})

describe('LyricsPanel scrolling', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.setItem('beacon.showVisualizer', 'false')
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('shows no scrollbar in the full-screen view, even for unsynced lyrics', async () => {
    // Synced lyrics never had one; unsynced ones deliberately do in the
    // drawer, where nothing else says "this scrolls". Full-screen, the
    // lyrics are the page and a bar down the side is chrome over artwork.
    await page.viewport(1200, 800)
    await mountPanel(false, 80)

    const scroll = document.querySelector('.lyrics-panel__scroll') as HTMLElement
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight) // it does overflow
    expect(scroll.offsetWidth - scroll.clientWidth).toBe(0)
  })

  it('opens already at the playing line when lyrics arrive mid-song', async () => {
    // Covered by the activeIndex watcher rather than by the lines watcher
    // added alongside this test — kept because it is the behaviour the
    // panel is expected to have, whichever of the two delivers it.
    await page.viewport(1200, 800)
    await mountPanel(true, 60, 160)

    const scroll = document.querySelector('.lyrics-panel__scroll') as HTMLElement
    const active = document.querySelector('.lyrics-panel__line--active') as HTMLElement
    expect(active).not.toBeNull()

    const scrollRect = scroll.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()
    const activeCentre = activeRect.top + activeRect.height / 2 - scrollRect.top
    // Centred in the box, not parked at the top.
    expect(scroll.scrollTop).toBeGreaterThan(0)
    expect(Math.abs(activeCentre - scrollRect.height / 2)).toBeLessThan(scrollRect.height * 0.15)
  })

  it('re-centres when the lines change but the playing index does not', async () => {
    // Picking a different match mid-song: same position, so the same line
    // number is playing, but every line is now a different height and the
    // active one has moved. The activeIndex watcher sees no change and
    // does nothing — without a watcher on the lines themselves, the panel
    // stays scrolled to wherever the *old* lines had put it.
    await page.viewport(1200, 800)
    const wrapper = await mountPanel(true, 60, 160)
    const lyrics = useLyricsStore()
    const indexBefore = document.querySelectorAll('.lyrics-panel__line--past').length

    lyrics.lines = lyrics.lines.map((line, i) => ({
      time: line.time,
      text: `Line ${i + 1} ${'with a considerably longer text that wraps onto several rows '.repeat(3)}`,
    }))
    await wrapper.vm.$nextTick()
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Same line is playing...
    expect(document.querySelectorAll('.lyrics-panel__line--past').length).toBe(indexBefore)
    // ...and it is back in the middle rather than off-screen.
    const scroll = document.querySelector('.lyrics-panel__scroll') as HTMLElement
    const active = document.querySelector('.lyrics-panel__line--active') as HTMLElement
    const scrollRect = scroll.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()
    const activeCentre = activeRect.top + activeRect.height / 2 - scrollRect.top
    expect(Math.abs(activeCentre - scrollRect.height / 2)).toBeLessThan(scrollRect.height * 0.2)
  })
})
