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
    photo: element('.detail-page__backdrop--photo').getBoundingClientRect(),
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

  it('never runs wider than the page', async () => {
    const { photo } = await mountPage(600, 40)

    expect(photo.width).toBeCloseTo(1200, 0)
  })
})
