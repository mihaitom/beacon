// Real-browser test for the full-size artwork viewer — run via
// `pnpm test:layout`. What it checks is pure layout (viewport units,
// min(), a square box holding a portrait image), which jsdom computes none
// of: the bug this exists for was a `min(82vh, 100%)` box size whose
// percentage had no definite height to resolve against, so the cap fell
// away entirely and a portrait artist photo ran off the bottom of the
// window. In jsdom that renders identically to the fixed version.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import ArtworkLightbox from '../ArtworkLightbox.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

/** A deliberately extreme portrait picture (1:3), as an SVG data URL so no
 * network or backend is involved — the shape is the point, not the pixels.
 * Real artist photos are frequently portrait; this is that case pushed far
 * enough that any missing height cap shows up as a large overflow rather
 * than a few pixels. */
const PORTRAIT = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1200"><rect width="400" height="1200" fill="#c47"/></svg>',
)}`

/** CoverArt.vue resolves its picture through the batching service and the
 * library client, neither of which has anything to do with the geometry
 * under test — stubbed down to the one thing that matters here: a real
 * <img> of a real shape, in the real box the lightbox hands it (the `size`
 * prop, applied exactly as the real component applies it).
 *
 * A render function rather than a `template` string: this runs against the
 * runtime-only Vue build, which compiles no templates at all and silently
 * renders such a stub as nothing. */
const CoverArtStub = defineComponent({
  name: 'CoverArt',
  props: {
    size: { type: [String, Number], default: '' },
    coverArtId: { type: String, default: null },
    imageUrl: { type: String, default: null },
    rounded: { type: Boolean, default: false },
    fallbackIcon: { type: String, default: '' },
    fullSize: { type: Boolean, default: false },
    contain: { type: Boolean, default: false },
  },
  setup(props) {
    return () =>
      h('div', { class: 'cover-art', style: { width: props.size, height: props.size } }, [
        h('img', { src: PORTRAIT, style: 'width: 100%; height: 100%; object-fit: contain' }),
      ])
  },
})

/** Inside a real <v-app>, the way App.vue mounts it. Vuetify's overlay
 * machinery hangs its container off that root and constrains a dialog
 * against it (`max-height: calc(100% - 48px)`); mounted bare on the body
 * there is nothing for those to resolve against and every dialog measures
 * as unconstrained, which would make this whole file pass for the wrong
 * reason. */
function mountLightbox() {
  const wrapper = mount(
    defineComponent({
      setup: () => () => h(components.VApp, null, { default: () => h(ArtworkLightbox) }),
    }),
    {
      attachTo: document.body,
      global: { plugins: [vuetify, i18n], stubs: { CoverArt: CoverArtStub } },
    },
  )
  wrappers.push(wrapper)
  return wrapper
}

async function showPortrait(wrapper: VueWrapper) {
  emitter.emit('showArtwork', { imageUrl: 'https://cdn.example/tall.jpg', title: 'Tinlicker' })
  await wrapper.vm.$nextTick()
  // The dialog animates in; one frame is enough for it to be laid out.
  await new Promise((resolve) => requestAnimationFrame(resolve))
}

/** The artwork's own box, measured. Its *position* deliberately isn't
 * asserted anywhere in this file: where the overlay centres itself depends
 * on the app shell around it, and what went wrong here was the box's own
 * size — a portrait picture made it as tall as the picture. */
function artBox(): DOMRect {
  return document.querySelector('.artwork-lightbox__art')!.getBoundingClientRect()
}

/** CoverArt's own `.cover-art { background: ... }`, restated as a real
 * stylesheet rule - the stub above cannot carry it inline, because an
 * inline style would be unbeatable and the whole question here is whether
 * the lightbox's rule beats the component's. Kept faint and grey like the
 * original; only that it is *there* matters. */
function paintCoverArtFill(): void {
  const style = document.createElement('style')
  style.textContent = '.cover-art { background: rgba(255, 255, 255, 0.06); }'
  style.dataset.testFill = 'cover-art'
  document.head.appendChild(style)
}

describe('ArtworkLightbox layout', () => {
  afterEach(() => {
    document.querySelectorAll('style[data-test-fill]').forEach((el) => el.remove())
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    emitter.all.clear()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('keeps a portrait picture within the height of the window', async () => {
    await page.viewport(1200, 800)
    const wrapper = mountLightbox()

    await showPortrait(wrapper)

    const art = artBox()
    expect(art.height).toBeGreaterThan(0)
    // 72vh, the cap the component asks for. Before the fix this measured
    // the picture's own 1200px height, on an 800px-tall window.
    expect(art.height).toBeLessThanOrEqual(window.innerHeight * 0.75)
  })

  /** The box is square and the picture inside it is contained, so on a
   * portrait photo the box is wider than what it holds. Anything painted
   * behind it is therefore visible as bars down both sides - which is what
   * CoverArt's own placeholder fill did here, right for a grid and wrong
   * for a picture on a dimmed backdrop.
   *
   * The rule that removes it has to out-specify CoverArt's own, since both
   * land on the same element; that is what this actually pins. */
  it('shows the picture with nothing painted behind it', async () => {
    await page.viewport(1200, 800)
    paintCoverArtFill()
    const wrapper = mountLightbox()

    await showPortrait(wrapper)

    const art = document.querySelector('.artwork-lightbox__art')!
    expect(getComputedStyle(art).backgroundColor).toBe('rgba(0, 0, 0, 0)')
  })

  it('keeps the caption with it rather than pushing it off', async () => {
    await page.viewport(1200, 800)
    const wrapper = mountLightbox()

    await showPortrait(wrapper)

    const caption = document.querySelector('.artwork-lightbox__caption')!.getBoundingClientRect()
    expect(caption.height).toBeGreaterThan(0)
    // Artwork plus caption plus the dialog's own margin still has to be a
    // windowful — this is why the cap above is 72vh and not 100.
    expect(artBox().height + caption.height).toBeLessThanOrEqual(window.innerHeight)
  })

  it('runs out of width first on a narrow window', async () => {
    // A phone-shaped window: the 86vw side of the cap is the binding one
    // here, and a square box any wider would be cut off left and right.
    await page.viewport(400, 900)
    const wrapper = mountLightbox()

    await showPortrait(wrapper)

    expect(artBox().width).toBeLessThanOrEqual(window.innerWidth * 0.9)
  })

  it('runs out of height first on a short one', async () => {
    // A laptop in a half-height window — the case a cap expressed in
    // anything but viewport units stops holding.
    await page.viewport(1000, 420)
    const wrapper = mountLightbox()

    await showPortrait(wrapper)

    expect(artBox().height).toBeLessThanOrEqual(window.innerHeight * 0.75)
  })
})
