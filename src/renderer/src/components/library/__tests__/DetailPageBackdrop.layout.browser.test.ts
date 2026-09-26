// Real-browser test for DetailPageBackdrop.vue's `banded` arrangement - run
// via `pnpm test:layout`. The page's height, the list's own scrolling and
// the photo's width (aspect-ratio on an absolutely positioned layer) are
// all layout; jsdom computes none of them, so it would pass whatever the
// page actually did.
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import DetailPageBackdrop from '../DetailPageBackdrop.vue'

const wrappers: VueWrapper[] = []

/** A page with a header of `headerHeight` and a track list of `listHeight`
 * below it, in a window of 1200×800. */
async function mountPage(headerHeight: number, listHeight: number) {
  await page.viewport(1200, 800)
  document.body.style.margin = '0'
  const wrapper = mount(DetailPageBackdrop, {
    props: { url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', isPhoto: true, banded: true },
    slots: {
      default: () => h('div', { style: { height: `${headerHeight}px` } }),
      below: () => h('div', { class: 'list', style: { height: `${listHeight}px` } }),
    },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  const element = (selector: string) => document.querySelector(selector)!
  return {
    page: element('.detail-page').getBoundingClientRect(),
    band: element('.detail-page__band').getBoundingClientRect(),
    below: element('.detail-page__below'),
    photo: element('.detail-page__art').getBoundingClientRect(),
  }
}

describe('DetailPageBackdrop banded layout', () => {
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
  })

  it('keeps the header in view and scrolls a long track list on its own', async () => {
    const { page: pageRect, band, below } = await mountPage(320, 2000)

    expect(pageRect.height).toBeCloseTo(800, 0)
    expect(band.height).toBeCloseTo(320, 0)
    expect(below.clientHeight).toBeCloseTo(480, 0)
    // Only a real scroll container keeps a scroll position of its own.
    below.scrollTop = 300
    expect(below.scrollTop).toBe(300)
  })

  it('sizes the photo from the header height, at the right edge', async () => {
    const { band, photo } = await mountPage(320, 100)

    // 320px of header is 768px of 2.4:1 photo - less than the window's
    // width, so it sits at the right edge rather than spanning the page.
    expect(photo.height).toBeCloseTo(band.height, 0)
    expect(photo.width).toBeCloseTo(band.height * 2.4, 0)
    expect(photo.right).toBeCloseTo(1200, 0)
  })

  it('keeps the scaled cover wash from widening the page', async () => {
    // The reported bug: scale(1.1) ran the wash 5% past the right edge,
    // and a tablet's browser laid the whole page out that much wider.
    await page.viewport(1024, 768)
    document.body.style.margin = '0'
    const wrapper = mount(DetailPageBackdrop, {
      props: { url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', isPhoto: false, show: true },
      slots: { default: () => h('div', { style: { height: '300px' } }) },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    expect(document.querySelector('.detail-page__backdrop')).not.toBeNull()
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1024)
  })

  it('never runs wider than the page', async () => {
    const { photo } = await mountPage(500, 40)

    expect(photo.width).toBeCloseTo(1200, 0)
  })
})

/** A 1920x1080 photo: a bright subject in the middle, on a plain dark
 * background - or, `busy`, a different colour in every stripe out to the
 * edges, as a photo of a stage or a street is, left edge included. */
function photoUrl(busy: boolean): string {
  const canvas = document.createElement('canvas')
  canvas.width = 1920
  canvas.height = 1080
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'rgb(20, 20, 20)'
  ctx.fillRect(0, 0, 1920, 1080)
  if (busy) {
    for (let x = 0; x < 1920; x += 40) {
      ctx.fillStyle = `hsl(${(x * 7) % 360}, 70%, 50%)`
      ctx.fillRect(x, 0, 40, 1080)
    }
  }
  ctx.fillStyle = 'rgb(240, 240, 240)'
  ctx.fillRect(760, 200, 400, 880)
  return canvas.toDataURL()
}

/** An artist-style page: a hero with a short name, in a window `width`
 * wide. */
async function mountArtist(width: number, busy: boolean) {
  await page.viewport(width, 900)
  document.body.style.margin = '0'
  const wrapper = mount(DetailPageBackdrop, {
    props: { url: photoUrl(busy), isPhoto: true },
    slots: {
      default: () =>
        h('section', { class: 'detail-hero' }, [
          h('div', { class: 'detail-hero__main', style: { padding: '40px' } }, [
            h('h1', { style: { margin: 0, fontSize: '48px' } }, 'The Tide'),
          ]),
        ]),
    },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  const band = () => document.querySelector('.detail-page__band') as HTMLElement
  await expect.poll(() => band().style.getPropertyValue('--text-end')).not.toBe('')
  // The photo's colours are read from a canvas once it has loaded.
  await new Promise((resolve) => setTimeout(resolve, 300))
  return {
    band: band().getBoundingClientRect(),
    art: document.querySelector('.detail-page__art')!.getBoundingClientRect(),
    filled: document.querySelector('.detail-page__backdrop--filled') !== null,
  }
}

describe('DetailPageBackdrop photo beside the header text', () => {
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
  })

  it('continues a smooth left edge to the left of the photo, which keeps to the right', async () => {
    const { band, art, filled } = await mountArtist(2800, false)

    expect(filled).toBe(true)
    expect(art.right).toBeCloseTo(band.right, 0)
  })

  it('continues nothing from a busy left edge', async () => {
    const { band, art, filled } = await mountArtist(2800, true)

    expect(filled).toBe(false)
    expect(art.right).toBeCloseTo(band.right, 0)
  })
})
