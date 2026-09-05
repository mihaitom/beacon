// Real-browser test for how much of the phone screen Now Playing actually
// uses — run via `pnpm test:layout`. Nothing here is visible to jsdom: the
// sizes come from container-query units measured against a stage whose own
// height is `100dvh` minus Vuetify's live layout offsets.
//
// What it pins down: the artwork is sized by artSize(), and in the compact
// layout the flip card is exactly the artwork plus the info block — so the
// lyrics panel and the radio title log on its back face are sized by the
// same number. One cautious fraction there made all three small at once,
// which is how a 234px cover ended up sitting in 358px of room on a 390px
// phone, with a third of the width and half the height of the stage unused.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@/assets/base.css'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useDrawersStore } from '@/stores/drawers'
import MobileNowPlayingView from '../mobile/MobileNowPlayingView.vue'
import NowPlayingView from '../NowPlayingView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

/** Phones in portrait, a phone on its side, and a small tablet — the range
 * the mobile layout is used across (it takes over below 960px). */
const PORTRAIT: [number, number][] = [
  [360, 740],
  [390, 844],
  [412, 915],
  [430, 932],
]
const ALL: [number, number][] = [...PORTRAIT, [844, 390], [768, 1024]]

async function mountAt(w: number, h: number, radio = false) {
  await page.viewport(w, h)
  const playback = usePlaybackStore()
  if (radio) {
    playback.radioStation = {
      id: 'r1',
      name: 'Chill FM',
      streamUrl: 'https://stream.example/chill',
      homePageUrl: null,
    }
    playback.radioTitleLog = Array.from({ length: 50 }, (_, i) => ({
      title: `Artist ${i} - Track ${i}`,
      at: 1_757_000_000 + i * 200,
    }))
    useDrawersStore().lyricsDrawerOpen = true
  } else {
    playback.queue = [makeSong('s1')]
    playback.currentIndex = 0
  }
  document.body.setAttribute('style', 'margin:0')
  // What MobileLayout.vue's app bar provides — the view is mounted on its
  // own here, so the target it teleports its buttons into has to be too.
  const actions = document.createElement('span')
  actions.id = 'mobile-app-bar-actions'
  actions.setAttribute(
    'style',
    'position:fixed;top:0;right:0;display:flex;align-items:center;height:56px',
  )
  document.body.appendChild(actions)
  const wrapper = mount(MobileNowPlayingView, {
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      mocks: {
        $emitter: { emit: () => {}, on: () => {}, off: () => {} },
        $router: { push: () => {} },
      },
      stubs: { AudioVisualizer: true, VisualizerDebugOverlay: true, RouterLink: true },
    },
  })
  wrappers.push(wrapper)
  // The stage measures itself before container queries resolve against it.
  await new Promise((resolve) => setTimeout(resolve, 120))
  return wrapper
}

function box(selector: string): DOMRect {
  return document.querySelector(selector)!.getBoundingClientRect()
}

/** The largest square that fits once the content padding, the info block
 * and the gap above it have taken their share — what artSize() is trying
 * to approach. */
function roomForArtwork(): number {
  const stage = box('.now-playing__stage')
  const info = box('.now-playing__info')
  const primary = box('.now-playing__primary')
  const art = box('.now-playing__primary .v-avatar, .now-playing__primary .cover-art')
  const style = getComputedStyle(document.querySelector('.now-playing__content')!)
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
  const gap = info.top - (primary.top + art.height)
  return Math.min(stage.width - padX, stage.height - padY - info.height - gap)
}

describe('Now Playing on the phone', () => {
  beforeEach(() => setActivePinia(createPinia()))

  afterEach(async () => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
    document.body.removeAttribute('style')
    await page.viewport(1280, 900)
  })

  it.each(PORTRAIT)('fills the room it has at %ix%i', async (w, h) => {
    await mountAt(w, h)
    const art = box('.now-playing__primary .v-avatar, .now-playing__primary .cover-art')

    // Within a small margin of the largest square that fits. The previous
    // 60cqw put this at roughly 65%.
    expect(art.width / roomForArtwork()).toBeGreaterThan(0.9)
  })

  it.each(ALL)('never overflows the stage at %ix%i', async (w, h) => {
    // The stage clips (`overflow: hidden`), so growing the artwork without
    // checking this would hide the artist and album lines rather than
    // reporting anything.
    await mountAt(w, h)
    const stage = box('.now-playing__stage')
    const content = box('.now-playing__content')

    expect(content.top).toBeGreaterThanOrEqual(stage.top - 1)
    expect(content.bottom).toBeLessThanOrEqual(stage.bottom + 1)
    expect(content.right).toBeLessThanOrEqual(stage.right + 1)
  })

  it('puts its buttons in the app bar instead of on top of the artwork', async () => {
    // They used to float in the artwork's top-right corner, which only
    // worked while the artwork left a corner free. Now that it uses the
    // width it has, an overlay there sits on the cover.
    await mountAt(390, 844)
    const toolbar = document.querySelector('.now-playing__toolbar')!
    const art = box('.now-playing__primary .v-avatar, .now-playing__primary .cover-art')
    const bar = toolbar.getBoundingClientRect()

    expect(document.querySelector('#mobile-app-bar-actions')!.contains(toolbar)).toBe(true)
    expect(getComputedStyle(toolbar).position).toBe('static')
    // Clear of the cover entirely, not merely mostly.
    expect(bar.bottom).toBeLessThanOrEqual(art.top)
  })

  it('keeps the toolbar in place when there is no app bar to dock into', async () => {
    // A Teleport pointed at nothing does not quietly do nothing — it
    // throws on unmount. This view is mounted on its own in other tests,
    // and could be anywhere else tomorrow.
    await page.viewport(390, 844)
    const playback = usePlaybackStore()
    playback.queue = [makeSong('s1')]
    playback.currentIndex = 0
    const wrapper = mount(NowPlayingView, {
      props: { compact: true },
      attachTo: document.body,
      global: {
        plugins: [vuetify, i18n],
        mocks: {
          $emitter: { emit: () => {}, on: () => {}, off: () => {} },
          $router: { push: () => {} },
        },
        stubs: { AudioVisualizer: true, VisualizerDebugOverlay: true, RouterLink: true },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(wrapper.find('.now-playing__toolbar').exists()).toBe(true)
    expect(() => wrapper.unmount()).not.toThrow()
  })

  it('leaves the toolbar over the artwork on a desktop window', async () => {
    // The desktop has no such target, and in fullscreen only this view's
    // own subtree is shown — anything hung outside it would disappear
    // exactly when it is the only way to reach lyrics.
    await page.viewport(1280, 900)
    const playback = usePlaybackStore()
    playback.queue = [makeSong('s1')]
    playback.currentIndex = 0
    const wrapper = mount(NowPlayingView, {
      attachTo: document.body,
      global: {
        plugins: [vuetify, i18n],
        mocks: {
          $emitter: { emit: () => {}, on: () => {}, off: () => {} },
          $router: { push: () => {} },
        },
        stubs: { AudioVisualizer: true, VisualizerDebugOverlay: true, RouterLink: true },
      },
    })
    wrappers.push(wrapper)
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(getComputedStyle(wrapper.get('.now-playing__toolbar').element).position).toBe('absolute')
  })

  it('gives the radio title log the whole card, not a corner of it', async () => {
    // The log is the back face of the flip card, so it is only as big as
    // the front — which is why the artwork's size decides how much of a
    // thousand-entry log is readable at once.
    await mountAt(390, 844, true)
    const card = box('.now-playing__flip-card')
    const log = box('.title-log')

    expect(log.width).toBeCloseTo(card.width, 0)
    expect(log.height).toBeCloseTo(card.height, 0)
    expect(log.height).toBeGreaterThan(300)
  })
})
