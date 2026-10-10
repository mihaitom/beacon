// Real-browser test for how much of the phone screen Now Playing actually
// uses — run via `pnpm test:layout`. Nothing here is visible to jsdom: the
// sizes come from container-query units measured against a stage whose own
// height is `100dvh` minus Vuetify's live layout offsets.
//
// What it pins down: the artwork is sized by artSize() and centred on the
// front face, while the flip card - and so the lyrics panel / radio title
// log on its back face - spans the phone's full width and the stage's full
// height. The card used to be sized to its own contents, which left the
// lyrics only as wide as the cover: a 234px cover in 358px of room on a
// 390px phone, with a third of the width and half the height of the stage
// unused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
// Same order as main.ts: the app's own stylesheet first, which is what
// makes base.css's @layer declaration the authoritative one. Reversed,
// @layer base lands behind Vuetify's utility layer and its `* { margin: 0 }`
// reset silently cancels every mb-*/pa-* in the markup under test.
import '@/assets/main.css'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useDrawersStore } from '@/stores/drawers'
import MobileNowPlayingView from '../mobile/MobileNowPlayingView.vue'
import NowPlayingView from '../NowPlayingView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import { useRadioMetadataStore } from '@/stores/radioMetadata'
import { useLyricsStore } from '@/stores/lyrics'
import { getArtistArt } from '@/services/connect/fanart'
import { appAccent } from '@/services/appAccent'
import {
  bottomScrimStrength,
  colourBehindControls,
  measureBottomColor,
} from '@/services/imageBrightness'

// A network lookup the layout under test does not care about.
vi.mock('@/services/connect/fanart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/connect/fanart')>()),
  getArtistArt: vi.fn().mockResolvedValue(null),
}))

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

/** Phones on their side, from the smallest common one to a large Android
 * that is wider than the 960px breakpoint. */
const LANDSCAPE: [number, number][] = [
  [667, 375],
  [740, 360],
  [844, 390],
  [932, 430],
  [998, 448],
]

async function mountShell() {
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
      stubs: { VisualizerBars: true, VisualizerDebugOverlay: true, RouterLink: true },
    },
  })
  wrappers.push(wrapper)
  // The stage measures itself before container queries resolve against it.
  await new Promise((resolve) => setTimeout(resolve, 120))
  return wrapper
}

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
    useRadioMetadataStore().titleLog = Array.from({ length: 50 }, (_, i) => ({
      title: `Artist ${i} - Track ${i}`,
      at: 1_757_000_000 + i * 200,
    }))
    useDrawersStore().lyricsPanelOpen = true
  } else {
    playback.queue = [makeSong('s1')]
    playback.currentIndex = 0
  }
  return mountShell()
}

/** A song with a deliberately short title and a Fanart.tv background: the
 * artwork hides by default once one loads, which is the state both the
 * corner placement and the lyrics width below are about. `withLyrics`
 * additionally flips the card open; `title` overrides the short default
 * for the overflow case. */
async function mountSongWithBackground(
  w: number,
  h: number,
  withLyrics = false,
  title = 'Imma Be',
) {
  await page.viewport(w, h)
  vi.mocked(getArtistArt).mockResolvedValue({
    banner: null,
    // A real (tiny) image, so preloadImage/colour extraction actually resolve.
    background:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    backgrounds: [
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    ],
    logo: null,
  })
  const playback = usePlaybackStore()
  playback.setQueue([makeSong('s1', { title, artist: 'Black Eyed Peas', album: 'The E.N.D.' })], 0)
  if (withLyrics) {
    const lyrics = useLyricsStore()
    vi.spyOn(lyrics, 'ensureLoaded').mockResolvedValue()
    lyrics.synced = true
    lyrics.lines = [
      { time: 0, text: 'Imma be up in the club' },
      { time: 4, text: 'Imma be rocking the beat' },
    ]
    useDrawersStore().lyricsPanelOpen = true
  }
  return mountShell()
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
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getArtistArt).mockResolvedValue(null)
  })

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

  /** The back face is sized to the card, and the card used to be sized to
   * its own contents: a 421px box in a 647px stage on a 390x844 phone,
   * with the rest going unused. A station's title log is a list that can
   * always show more of itself, which is what made it visible. */
  it.each(PORTRAIT)('gives the title log the whole stage at %ix%i', async (w, h) => {
    await mountAt(w, h, true)
    const stage = box('.now-playing__stage')
    const log = box('.now-playing__lyrics')
    const content = getComputedStyle(document.querySelector('.now-playing__content')!)
    const padY = parseFloat(content.paddingTop) + parseFloat(content.paddingBottom)

    // Everything the stage has, less the content padding around it.
    expect(log.height).toBeCloseTo(stage.height - padY, -0.5)
  })

  it('leaves the artwork and the title where they were while doing it', async () => {
    // The card grew, its front face did not: artwork and title stay
    // centred rather than drifting to the top of a taller box.
    await mountAt(390, 844, true)
    const stage = box('.now-playing__stage')
    const art = box('.now-playing__primary .v-avatar, .now-playing__primary .cover-art')
    const info = box('.now-playing__info')

    const above = art.top - stage.top
    const below = stage.bottom - info.bottom
    expect(Math.abs(above - below)).toBeLessThan(24)
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
        stubs: { VisualizerBars: true, VisualizerDebugOverlay: true, RouterLink: true },
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
        stubs: { VisualizerBars: true, VisualizerDebugOverlay: true, RouterLink: true },
      },
    })
    wrappers.push(wrapper)
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(getComputedStyle(wrapper.get('.now-playing__toolbar').element).position).toBe('absolute')
  })

  it('gives the radio title log the whole card, not a corner of it', async () => {
    // The log is the back face of the flip card, and on a phone the card
    // is the full width and height of the stage - so the log gets the
    // whole screen, not just the box the artwork occupied.
    await mountAt(390, 844, true)
    const card = box('.now-playing__flip-card')
    const log = box('.title-log')

    expect(log.width).toBeCloseTo(card.width, 0)
    expect(log.height).toBeCloseTo(card.height, 0)
    expect(log.height).toBeGreaterThan(300)
  })

  it('gives the lyrics the whole stage width, not just the artwork box', async () => {
    // With the artwork hidden the card used to be sized to the front face's
    // own contents - a short title and no cover - which left the lyrics
    // well under half a phone screen.
    await mountSongWithBackground(390, 844, true)
    const stage = box('.now-playing__stage')
    const card = box('.now-playing__flip-card')
    const content = getComputedStyle(document.querySelector('.now-playing__content')!)
    const padX = parseFloat(content.paddingLeft) + parseFloat(content.paddingRight)

    expect(card.width).toBeCloseTo(stage.width - padX, -1)
  })

  it('centres the track text at the bottom of the artist background', async () => {
    // The glass card it sat on used to cover a slab of the photo; plain text
    // over a scrim from the bottom leaves the picture to the picture.
    await mountSongWithBackground(390, 844)
    const stage = box('.now-playing__stage')
    const info = box('.now-playing__info')
    const bars = box('.now-playing__visualizer-row')

    expect(Math.abs(info.left + info.width / 2 - (stage.left + stage.width / 2))).toBeLessThan(2)
    expect(info.bottom).toBeGreaterThan(stage.bottom - 40)
    // Above the visualizer, whose bars rise from the stage's lower edge.
    expect(info.bottom).toBeLessThanOrEqual(bars.top + 1)
    expect(document.querySelector('.now-playing__bottom-scrim')).not.toBeNull()
  })

  it('keeps a long title on the screen', async () => {
    await mountSongWithBackground(
      390,
      844,
      false,
      'A Very Long Song Title That Could Never Fit In The Corner Panel At All',
    )
    const stage = box('.now-playing__stage')
    const title = box('.now-playing__title')

    expect(title.left).toBeGreaterThanOrEqual(stage.left)
    expect(title.right).toBeLessThanOrEqual(stage.right + 1)
    expect(title.bottom).toBeLessThanOrEqual(stage.bottom)
  })
})

describe('Now Playing on a phone held sideways', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getArtistArt).mockResolvedValue(null)
  })

  afterEach(async () => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
    document.body.removeAttribute('style')
    await page.viewport(1280, 900)
  })

  it.each(LANDSCAPE)('gives the artwork its whole column at %ix%i', async (w, h) => {
    // Upright, the artwork shares its column with the text and the
    // controls; sideways it has the left one to itself. Under them it came
    // out 88px at 844x390 and ran off the top of the stage. On a 16:9 phone
    // the column's width is the limit, the controls needing the rest.
    await mountAt(w, h)
    const stage = box('.now-playing__stage')
    const art = box('.now-playing__primary .cover-art')
    const style = getComputedStyle(document.querySelector('.now-playing__content')!)
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const room = Math.min(stage.width - padX, stage.height - padY)

    expect(art.height / room).toBeGreaterThan(0.9)
    expect(art.top).toBeGreaterThanOrEqual(stage.top)
    expect(art.bottom).toBeLessThanOrEqual(stage.bottom)
  })

  it.each(LANDSCAPE)('keeps the track text and every control on screen at %ix%i', async (w, h) => {
    await mountAt(w, h)
    const art = box('.now-playing__primary .cover-art')
    const info = box('.now-playing__info')
    const controls = document.querySelector('.mobile-transport')!

    for (const part of [info, controls.getBoundingClientRect()]) {
      // Beside the artwork, not over it...
      expect(part.left).toBeGreaterThanOrEqual(art.right)
      // ...and inside the screen, not clipped off its edge.
      expect(part.right).toBeLessThanOrEqual(w + 1)
      expect(part.top).toBeGreaterThanOrEqual(0)
      expect(part.bottom).toBeLessThanOrEqual(h + 1)
    }
    // Every button reachable: none squeezed to nothing or pushed past the
    // column.
    for (const button of controls.querySelectorAll('.v-btn')) {
      const rect = button.getBoundingClientRect()
      expect(rect.width).toBeGreaterThan(24)
      expect(rect.right).toBeLessThanOrEqual(w + 1)
    }
    // The text sits centred right above the controls rather than running
    // into them or off at the top of the column.
    const below = controls.getBoundingClientRect()
    expect(info.bottom).toBeLessThanOrEqual(below.top + 1)
    expect(info.bottom).toBeGreaterThan(below.top - 40)
    expect(Math.abs(info.left + info.width / 2 - (below.left + below.width / 2))).toBeLessThan(2)
    // Centred line by line too, not a left-aligned block in the middle.
    const title = document.querySelector('.now-playing__title')!
    expect(getComputedStyle(title).textAlign).toBe('center')
  })

  it('renders the controls once, beside the artwork instead of under it', async () => {
    // Upright they sit below the presentation; two copies would mean two
    // volume pollers and two device pickers.
    await mountAt(844, 390)

    expect(document.querySelectorAll('.mobile-transport')).toHaveLength(1)
    expect(document.querySelector('.now-playing__side-controls .mobile-transport')).not.toBeNull()
  })

  it('turns only the artwork over for the title log, leaving the controls usable', async () => {
    await mountAt(844, 390, true)
    const stage = box('.now-playing__stage')
    const log = box('.now-playing__lyrics')
    const controls = box('.mobile-transport')

    // The log takes the artwork's column, all of it...
    expect(log.right).toBeLessThanOrEqual(stage.right + 1)
    expect(log.height).toBeGreaterThan(300)
    // ...and the controls stay where they were, uncovered.
    expect(controls.left).toBeGreaterThanOrEqual(log.right)
  })

  it('keeps the toolbar on screen, with the app bar out of the way', async () => {
    // The app bar is hidden sideways; docked into it, the lyrics switch
    // would be gone with it.
    await mountAt(844, 390)
    const toolbar = document.querySelector('.now-playing__toolbar')!

    expect(document.querySelector('#mobile-app-bar-actions')!.contains(toolbar)).toBe(false)
    expect(document.querySelector('.now-playing__side-toolbar')!.contains(toolbar)).toBe(true)
  })

  it.each(LANDSCAPE)(
    'puts the text in the bottom-left corner with artwork and lyrics hidden at %ix%i',
    async (w, h) => {
      // No large cover to give a column to: the photo has the screen, the
      // text and the controls line its bottom edge.
      await mountSongWithBackground(w, h)
      const info = box('.now-playing__info')
      const controls = box('.mobile-transport')

      // The small cover leads the text from the corner, level with it.
      const mini = box('.now-playing__mini-art')
      expect(mini.left).toBeLessThan(w * 0.1)
      expect(mini.right).toBeLessThanOrEqual(info.left)
      expect(Math.abs(mini.bottom - info.bottom)).toBeLessThan(4)
      expect(mini.height).toBeLessThanOrEqual(info.height + 1)
      expect(info.bottom).toBeGreaterThan(h * 0.8)
      expect(info.bottom).toBeLessThanOrEqual(h)
      expect(controls.left).toBeGreaterThanOrEqual(info.right)
      expect(controls.right).toBeLessThanOrEqual(w + 1)
      expect(controls.bottom).toBeLessThanOrEqual(h)
    },
  )

  it.each(LANDSCAPE)(
    'gives the lyrics the full height left of the controls over the photo at %ix%i',
    async (w, h) => {
      // A square column for them, with no cover to match, wrapped every
      // line and left two on screen; across the full width they got a strip.
      await mountSongWithBackground(w, h, true)
      const lyrics = box('.now-playing__lyrics')
      const info = box('.now-playing__info')
      const controls = box('.mobile-transport')

      expect(lyrics.height).toBeGreaterThan(h * 0.85)
      expect(lyrics.width).toBeGreaterThan(w * 0.4)
      expect(lyrics.right).toBeLessThanOrEqual(controls.left)
      // The text back over the controls, centred, once the lyrics take the
      // corner it had.
      expect(info.left).toBeGreaterThanOrEqual(lyrics.right)
      expect(info.bottom).toBeLessThanOrEqual(controls.top + 1)
      expect(
        Math.abs(info.left + info.width / 2 - (controls.left + controls.width / 2)),
      ).toBeLessThan(2)
    },
  )

  it('darkens the bottom of a light photo more than of a dark one', async () => {
    // White labels over a pale photo washed out under the scrim a dark one
    // needs.
    async function scrimOver(colour: string): Promise<number> {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 64
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = colour
      ctx.fillRect(0, 0, 64, 64)
      const photo = canvas.toDataURL('image/png')
      vi.mocked(getArtistArt).mockResolvedValue({
        banner: null,
        background: photo,
        backgrounds: [photo],
        logo: null,
      })
      await page.viewport(844, 390)
      usePlaybackStore().setQueue([makeSong('s1')], 0)
      await mountShell()
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(document.querySelector('.now-playing__bottom-scrim')).not.toBeNull()
      const view = document.querySelector('.now-playing') as HTMLElement
      const strength = parseFloat(view.style.getPropertyValue('--photo-scrim'))
      while (wrappers.length) wrappers.pop()?.unmount()
      document.body.innerHTML = ''
      setActivePinia(createPinia())
      return strength
    }

    expect(await scrimOver('#f4f4f4')).toBeGreaterThan(await scrimOver('#181818'))
  })

  it('lifts the accent until the controls stand off a photo of the same colour', async () => {
    // A stage photo bathed in violet light gave violet buttons, which
    // vanished into it.
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#5a1fa8'
    ctx.fillRect(0, 0, 64, 64)
    const photo = canvas.toDataURL('image/png')
    vi.mocked(getArtistArt).mockResolvedValue({
      banner: null,
      background: photo,
      backgrounds: [photo],
      logo: null,
    })
    await page.viewport(844, 390)
    usePlaybackStore().setQueue([makeSong('s1')], 0)
    await mountShell()
    await new Promise((resolve) => setTimeout(resolve, 300))

    const bottom = (await measureBottomColor(photo))!
    const behind = colourBehindControls(bottom, bottomScrimStrength(bottom))
    const lum = (channels: number[]) => {
      const [r, g, b] = channels.map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const accent = lum(appAccent.value.split(',').map(Number))
    const ground = lum(behind)
    expect(
      (Math.max(accent, ground) + 0.05) / (Math.min(accent, ground) + 0.05),
    ).toBeGreaterThanOrEqual(3)
  })
})
