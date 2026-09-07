// Real-browser test for the "playing right now" highlight in the radio
// title log — run via `pnpm test:layout`. What it checks is a scoped CSS
// selector, which jsdom neither applies nor computes: a jsdom version
// passes whatever the rule says, including the `:first-child` this used to
// be, which stops matching the moment a date heading takes the first <li>
// slot in the list (see RadioTitleLog.vue's own comment).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import RadioTitleLog from '../RadioTitleLog.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 8, day, hour, minute).getTime() / 1000
}

function mountLog(entries: { title: string; at: number }[], variant?: 'compact' | 'immersive') {
  // currentAt: the list here is always the log itself, so its first entry
  // is the one on air. A search hands the component a list where that is
  // not true, which is why this is said rather than assumed - see the
  // prop's own comment.
  const current = entries[0]?.at ?? null
  const wrapper = mount(RadioTitleLog, {
    props: variant ? { entries, variant, currentAt: current } : { entries, currentAt: current },
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      mocks: { $router: { push: () => {} } },
      // See the jsdom suite's own note: @vue/test-utils stubs transition
      // groups by default, and this component needs the real one to render
      // as a fragment - a stub's wrapper element would take the timeline
      // items out of the grid these tests measure.
      stubs: { transition: false, 'transition-group': false },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

// Every entry in this file is dated (see at()), and what "today" is decides
// whether the log writes a date heading above it - a heading is a timeline
// item of its own, so it shifts every item these tests measure by index down
// by one. Frozen to the day the entries are from, so the suite reads the same
// on any day it runs rather than only on the one it was written; Date alone
// and not the timers, because the animation tests below wait on real
// requestAnimationFrame and setTimeout. The tests that want a heading set
// their own "now" on top of this.
beforeEach(() => {
  vi.setSystemTime(new Date(2026, 8, 6, 12, 30))
})

afterEach(() => vi.useRealTimers())

/** The colour the browser actually resolved for the newest track line. */
function newestTrackColor(wrapper: VueWrapper): string {
  const items = wrapper.findAll('.title-log__item')
  expect(items.length).toBeGreaterThan(0)
  return getComputedStyle(items[0]!.find('.title-log__track').element).color
}

describe('RadioTitleLog timeline layout', () => {
  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
  })

  /** Two separate things in this log make an alpha unusable, and both were
   * measured in the browser rather than reasoned about:
   *
   *  - Each segment is drawn 12px past its own row into the gap -
   *    Vuetify's arithmetic for its own 24px row gap - so against the
   *    tighter gap this log uses, the segment coming down from one row and
   *    the one going up from the next overlap by 14px. In Vuetify's own
   *    translucent border colour that was a brighter stretch in the middle
   *    of every gap, and read as the line having been drawn twice.
   *  - Each segment runs to the divider's vertical centre, which is the
   *    *centre* of the dot rather than its edge: the line carries on 13px
   *    underneath a 26px dot, and a translucent dot shows it doing so.
   *
   * Both variants, because neither of those is a property of the ground
   * the log is drawn on - the first attempt at the immersive rules used
   * rgba() and this test, then written for the drawer alone, stayed green
   * through it. A computed colour comes back as `rgb(...)` only when it is
   * fully opaque. */
  it.each(['compact', 'immersive'] as const)(
    'draws the %s line and dots opaque, so nothing shows through or doubles up',
    async (variant) => {
      await page.viewport(380, 700)
      const wrapper = mountLog(
        [
          { title: 'Artist - Newest', at: at(6, 11, 59) },
          { title: 'Artist - Older', at: at(6, 11, 51) },
        ],
        variant,
      )

      // Within one divider, not by a global index: a date heading is a
      // divider with line segments and no dot, so the two lists are not
      // aligned once one appears.
      const divider = wrapper.findAll('.v-timeline-divider').at(-1)!.element
      for (const selector of [
        '.v-timeline-divider__before',
        '.v-timeline-divider__after',
        '.v-timeline-divider__inner-dot',
      ]) {
        const part = divider.querySelector(selector)!
        expect(getComputedStyle(part).backgroundColor).not.toMatch(/rgba|\/\s*0?\.\d/)
      }
    },
  )

  /** The line runs behind the cards, so a translucent card shows it
   * straight through the middle of every entry - which the 2% white fill
   * a panel elsewhere in the app carries did. A computed colour comes back
   * as `rgb(...)` only when it is fully opaque. */
  it('paints the cards opaque, so the line cannot show through them', async () => {
    await page.viewport(380, 700)
    const wrapper = mountLog([
      { title: 'Artist - Newest', at: at(6, 11, 59) },
      { title: 'Artist - Older', at: at(6, 11, 51) },
    ])

    // Both of them: the newest card carries an amber tint of its own and
    // is the one most easily left translucent. A colour with no alpha
    // channel is what "opaque" reads as - `rgba(...)` for a plain colour,
    // `... / 0.5` for the mixed one.
    for (const card of wrapper.findAll('.title-log__item')) {
      expect(getComputedStyle(card.element).backgroundColor).not.toMatch(/rgba|\/\s*0?\.\d/)
    }
  })

  /** VTimelineItem measures the rendered dot on mount and writes the
   * result into --v-timeline-dot-size, which every line segment then
   * positions itself from. A hidden element measures zero - and this log
   * mounts inside a navigation drawer that starts closed, so the line was
   * drawn for a 0px dot and ran down the far left, beside the dots instead
   * of through them. Only a real browser can catch that: jsdom returns
   * zero for every measurement, so it cannot tell the bug from the fix. */
  it('draws the line through the dots even when it mounted out of sight', async () => {
    await page.viewport(380, 700)
    const host = document.createElement('div')
    host.setAttribute('style', 'display: none; width: 380px; height: 600px;')
    document.body.appendChild(host)

    const wrapper = mount(RadioTitleLog, {
      props: {
        entries: [
          { title: 'Artist - Newest', at: at(6, 11, 59) },
          { title: 'Artist - Older', at: at(6, 11, 51) },
        ],
      },
      attachTo: host,
      global: {
        plugins: [vuetify, i18n],
        mocks: { $router: { push: () => {} } },
        // See the jsdom suite's own note: @vue/test-utils stubs transition
        // groups by default, and this component needs the real one to render
        // as a fragment - a stub's wrapper element would take the timeline
        // items out of the grid these tests measure.
        stubs: { transition: false, 'transition-group': false },
      },
    })
    wrappers.push(wrapper)
    host.appendChild(wrapper.get('.title-log').element)

    // The drawer opens.
    host.setAttribute('style', 'display: block; width: 380px; height: 600px;')
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

    const dot = wrapper.findAll('.v-timeline-divider__dot')[1]!.element.getBoundingClientRect()
    const line = wrapper.findAll('.v-timeline-divider__before')[1]!.element.getBoundingClientRect()

    expect(dot.width).toBeGreaterThan(10)
    // Within a pixel of each other: the line has to come out of the dot's
    // middle, not run alongside it.
    expect(Math.abs((line.left + line.right) / 2 - (dot.left + dot.right) / 2)).toBeLessThan(1)
  })

  /** The gap that says nobody was listening for a while. Measured rather
   * than asserted on a class, because the class alone passes while nothing
   * moves: `.v-timeline-item` is `display: contents`, so it has no box for
   * a margin to apply to and the space has to go on its two children. */
  it('leaves a gap in the line where the listening broke off', async () => {
    await page.viewport(380, 700)
    const wrapper = mountLog([
      { title: 'Artist - Newest', at: at(6, 12, 0) },
      // An hour of something else, then four minutes of ordinary listening.
      { title: 'Artist - After the break', at: at(6, 11, 0) },
      { title: 'Artist - Before it', at: at(6, 10, 56) },
    ])

    const cards = wrapper
      .findAll('.title-log__item')
      .map((card) => card.element.getBoundingClientRect())
    const acrossTheBreak = cards[1]!.top - cards[0]!.bottom
    const ordinary = cards[2]!.top - cards[1]!.bottom

    expect(acrossTheBreak).toBeGreaterThan(ordinary + 15)
  })

  /** The one real cost of a timeline in a 380px drawer: its dot column
   * pushes the text right, and the title line already truncates. Pinned
   * here so a later, larger dot cannot quietly take the title's width -
   * jsdom computes no layout at all and would pass any dot size. */
  it('keeps the dot column narrow enough to leave the titles their width', async () => {
    await page.viewport(380, 700)
    const wrapper = mountLog([{ title: 'Artist - Track', at: at(6, 11, 59) }])

    const scroll = wrapper.get('.title-log__scroll').element.getBoundingClientRect()
    const card = wrapper.get('.title-log__item').element.getBoundingClientRect()
    const time = wrapper.get('.title-log__time').element.getBoundingClientRect()

    // Everything left of the clock: the inset that keeps the line off the
    // panel edge, the dot, the gap after it and the card's own padding.
    // Measured at 57px with the 26px dot the icons need; the budget is
    // what a larger one would have to stay inside of, not the current
    // value with no room around it.
    expect(time.left - scroll.left).toBeLessThanOrEqual(72)

    // And the card fills what is left rather than shrinking to its own
    // text. Vuetify justifies a timeline body to the start of its column,
    // which sized every card to its own title and left a ragged edge down
    // the log until the component overrode it.
    expect(card.width).toBeGreaterThan(scroll.width * 0.8)
    expect(scroll.right - card.right).toBeLessThanOrEqual(16)
  })
})

/** Half a pixel of slack: the browser rounds these boxes, and a test that
 * demanded exact equality would fail on a fractional layout rather than on
 * the thing it is here to catch. */
const SUBPIXEL = 0.5

/** Mounts the log into a box of a fixed height, the way both real callers
 * do (the drawer slot, NowPlayingView's .now-playing__lyrics) - the
 * component sizes nothing itself, so a log attached straight to the body
 * is as tall as its content and never scrolls. */
function mountInBox(entries: { title: string; at: number }[], height: number) {
  const host = document.createElement('div')
  host.setAttribute('style', `width: 380px; height: ${height}px; display: flex;`)
  document.body.appendChild(host)
  const wrapper = mount(RadioTitleLog, {
    props: { entries },
    attachTo: host,
    global: {
      plugins: [vuetify, i18n],
      mocks: { $router: { push: () => {} } },
      // See the jsdom suite's own note: @vue/test-utils stubs transition
      // groups by default, and this component needs the real one to render
      // as a fragment - a stub's wrapper element would take the timeline
      // items out of the grid these tests measure.
      stubs: { transition: false, 'transition-group': false },
    },
  })
  wrappers.push(wrapper)
  // Straight into the sized box: the wrapper element vue-test-utils mounts
  // into is an ordinary auto-height div, and a log left inside it is as
  // tall as its own content however short the host is.
  host.appendChild(wrapper.get('.title-log').element)
  return wrapper
}

function manyEntries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    title: `Artist ${index} - Track ${index}`,
    at: at(6, 12) - index * 240,
  }))
}

/** The scroller's own fade depth, read back from the element rather than
 * duplicated here - the whole point of the assertions below is that the
 * padding and the mask are driven by this one value. */
function fadeDepth(scroll: HTMLElement): number {
  return parseFloat(getComputedStyle(scroll).getPropertyValue('--title-log-fade'))
}

describe('RadioTitleLog edge fade', () => {
  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
  })

  /** The mask and the padding that keeps content out of it are the same
   * number, and have to stay the same number: padding smaller than the
   * fade leaves the newest entry permanently half-transparent, padding
   * larger than it opens a gap above the first dot. jsdom parses neither
   * the custom property nor mask-image, so only a real browser can tie
   * the two together. */
  it('pads both ends by exactly the depth the mask fades over', async () => {
    await page.viewport(380, 700)
    const wrapper = mountInBox(manyEntries(20), 400)
    const scroll = wrapper.get('.title-log__scroll').element as HTMLElement
    const style = getComputedStyle(scroll)
    const list = getComputedStyle(wrapper.get('.title-log__list').element)
    const fade = fadeDepth(scroll)

    expect(fade).toBeGreaterThan(0)
    // On the list, not on the scroller: Blink drops a scroll container's
    // own bottom padding once the content overflows it.
    expect(parseFloat(list.paddingTop)).toBeCloseTo(fade, 1)
    expect(parseFloat(list.paddingBottom)).toBeCloseTo(fade, 1)
    // A mask, not a background gradient: this panel sits on the drawer's
    // solid surface and on Now Playing's blurred artwork, and an overlay
    // painted in one background colour is wrong on the other.
    expect(style.maskImage).toContain('gradient')
    expect(style.maskImage).toContain(`${fade}px`)
  })

  /** Regression: with the log scrolled to either end, the entry that comes
   * to rest there is the one a reader is looking at - the newest one at
   * the top especially, which is what the log is usually opened for. Both
   * have to sit clear of the fade rather than inside it. */
  it('keeps the first and last entry out of the fade at either end', async () => {
    await page.viewport(380, 700)
    const wrapper = mountInBox(manyEntries(20), 400)
    const scroll = wrapper.get('.title-log__scroll').element as HTMLElement
    const cards = wrapper.findAll('.title-log__item')
    const fade = fadeDepth(scroll)

    // Actually scrollable, or neither end proves anything.
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight + fade)

    const top = scroll.getBoundingClientRect()
    expect(cards[0]!.element.getBoundingClientRect().top - top.top).toBeGreaterThanOrEqual(
      fade - SUBPIXEL,
    )

    scroll.scrollTop = scroll.scrollHeight
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

    const bottom = scroll.getBoundingClientRect()
    const last = cards[cards.length - 1]!.element.getBoundingClientRect()
    expect(bottom.bottom - last.bottom).toBeGreaterThanOrEqual(fade - SUBPIXEL)
  })
})

/** The three colour channels of a computed value, on a 0-255 scale.
 *
 * Normalised because the browser hands back two different spellings here:
 * a plain colour serialises as `rgb(68, 60, 39)`, but the output of a
 * color-mix() - which is what every line and dot in this component is -
 * comes back as `color(srgb 0.26 0.23 0.15)`, on 0-1. Comparing those two
 * without noticing is how a colour test quietly stops testing. */
function channels(colour: string): number[] {
  const raw = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  const scale = raw.every((c) => c <= 1) ? 255 : 1
  return raw.map((c) => c * scale)
}

/** All three channels equal within rounding — a white or a grey, something
 * that takes its contrast from the ground rather than from a hue.
 *
 * Asked this way, and never against "is it amber", because the Vuetify
 * instance these tests mount carries its own default palette rather than
 * Beacon's (the theme lives inline in main.ts): `primary` resolves to
 * Vuetify's blue here. What the rules under test actually claim is a
 * *role* — neutral chrome on the backdrop, the theme's accent on the one
 * mark — and asserting the role is both true in this harness and immune to
 * a change of shade later. */
function isNeutral(colour: string): boolean {
  const [r, g, b] = channels(colour)
  return Math.abs(r! - g!) <= 2 && Math.abs(g! - b!) <= 2
}

/** Whether an element is painted in the theme's accent, as this Vuetify
 * instance resolves it - read off the element itself rather than written
 * out here, for the reason isNeutral() gives. Compared channel by channel
 * because the two spellings differ in whitespace. */
function isAccent(el: Element): boolean {
  const style = getComputedStyle(el)
  const want = channels(style.getPropertyValue('--v-theme-primary'))
  const got = channels(style.backgroundColor)
  return want.length === 3 && want.every((c, i) => Math.abs(c - got[i]!) <= 2)
}

describe('RadioTitleLog on the Now Playing backdrop', () => {
  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
  })

  /** The drawer mixes the line and the ordinary dots into
   * --v-theme-background, which is exactly the ground they are drawn on
   * there. Now Playing has no such ground: the log sits on blurred artwork
   * under a scrim tinted with the colour taken from the station's own
   * logo, and a warm logo tints it the same amber the timeline is built
   * out of. jsdom resolves neither color-mix() nor the variables under it,
   * so only a real browser can tell the two variants apart at all. */
  it('drops the accent from the line and the ordinary dots', async () => {
    await page.viewport(560, 700)
    const wrapper = mountLog(
      [
        { title: 'Artist - Newest', at: at(6, 11, 59) },
        { title: 'Artist - Older', at: at(6, 11, 51) },
      ],
      'immersive',
    )

    for (const selector of ['.v-timeline-divider__before', '.v-timeline-divider__after']) {
      const line = wrapper.findAll(selector)[1]!.element
      expect(isNeutral(getComputedStyle(line).backgroundColor)).toBe(true)
    }
    // The second entry's dot: an ordinary one, not the mark.
    const dots = wrapper.findAll('.v-timeline-divider__inner-dot')
    expect(isNeutral(getComputedStyle(dots[1]!.element).backgroundColor)).toBe(true)
  })

  /** And the one dot that is a mark keeps it — on this ground more than on
   * the other, since it is now the only accent left in the panel. */
  it('keeps the accent on the entry playing right now', async () => {
    await page.viewport(560, 700)
    const wrapper = mountLog(
      [
        { title: 'Artist - Newest', at: at(6, 11, 59) },
        { title: 'Artist - Older', at: at(6, 11, 51) },
      ],
      'immersive',
    )

    const dot = wrapper.findAll('.v-timeline-divider__inner-dot')[0]!.element
    expect(isAccent(dot)).toBe(true)
  })

  /** The drawer is untouched: its ground *is* --v-theme-background, and
   * the mixed accent is what makes the line read as one of the app's own
   * hairlines there rather than as a grey rule through it. */
  it('leaves the drawer variant on its tinted line', async () => {
    await page.viewport(380, 700)
    const wrapper = mountLog([
      { title: 'Artist - Newest', at: at(6, 11, 59) },
      { title: 'Artist - Older', at: at(6, 11, 51) },
    ])

    const line = wrapper.findAll('.v-timeline-divider__before')[1]!.element
    expect(isNeutral(getComputedStyle(line).backgroundColor)).toBe(false)
  })

  /** Same trap as the track colour next door, one element over: the marked
   * dot used to be selected with :first-child, which stops picking the
   * newest *entry* as soon as a date heading takes the first <li> slot
   * above it. Keyed off Vuetify's own fill-dot class now, which comes from
   * the same LogRow.newest flag the row body reads. */
  it('marks the newest entry even when a date heading comes above it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 6, 8, 30))
    await page.viewport(380, 700)
    // Nothing from today, so the first <li> is the heading, not an entry.
    const wrapper = mountLog([{ title: 'Artist - Last night', at: at(5, 23, 50) }])
    vi.useRealTimers()

    expect(wrapper.find('.title-log__day').exists()).toBe(true)
    const dot = wrapper.get('.v-timeline-divider__inner-dot').element
    expect(isAccent(dot)).toBe(true)
    // And the size that goes with it, which had the same selector.
    expect(wrapper.get('.v-timeline-divider__dot').element.getBoundingClientRect().width).toBe(30)
  })
})

/** The one test that would have caught what the animation first got
 * wrong. Vue puts its transition classes on the .v-timeline-item, and
 * Vuetify gives that `display: contents` - an element with no box, where
 * opacity and transform do nothing at all. Everything looked right (the
 * classes were applied, the guard armed) and nothing moved. So this asks
 * the browser the only question that matters: is the arriving row actually
 * part-way through something? jsdom computes no transitions and would pass
 * either way. */
describe('RadioTitleLog new-title animation', () => {
  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
  })

  const older = [
    { title: 'Artist - Second', at: at(6, 11, 51) },
    { title: 'Artist - Third', at: at(6, 11, 42) },
  ]

  it('starts the arriving row transparent and offset, not at its final place', async () => {
    await page.viewport(380, 700)
    const wrapper = mountLog(older)

    await wrapper.setProps({
      entries: [{ title: 'Artist - Newest', at: at(6, 11, 59) }, ...older],
    })
    // One frame in: the enter class is on, the transition has been started
    // and has not had time to finish.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

    const card = wrapper.findAll('.v-timeline-item__body')[0]!.element
    const style = getComputedStyle(card)
    expect(Number(style.opacity)).toBeLessThan(1)
    expect(style.transform).not.toBe('none')

    // And still running well into it, not just for the one frame the
    // classes go on - a sample at the start alone would also pass on an
    // entrance that was cancelled immediately afterwards.
    await new Promise((resolve) => setTimeout(resolve, 140))
    expect(Number(getComputedStyle(card).opacity)).toBeLessThan(1)
  })

  /** And the guard actually reaches the browser: a page of older entries
   * arriving at the bottom must not animate thirty rows at once. */
  it('leaves an appended page of older entries alone', async () => {
    await page.viewport(380, 700)
    const wrapper = mountLog(older)

    await wrapper.setProps({
      entries: [...older, { title: 'Artist - Older', at: at(6, 10, 4) }],
    })
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

    const cards = wrapper.findAll('.v-timeline-item__body')
    const style = getComputedStyle(cards.at(-1)!.element)
    expect(Number(style.opacity)).toBe(1)
  })
})

describe('RadioTitleLog highlight', () => {
  afterEach(() => {
    vi.useRealTimers()
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('highlights the newest entry even when a date heading comes above it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 6, 8, 30))

    // Nothing from today, so the very first <li> in the list is the
    // "Yesterday" heading rather than an entry.
    const dated = mountLog([{ title: 'Artist - Last night', at: at(5, 23, 50) }])
    expect(dated.find('.title-log__day').exists()).toBe(true)

    // Same component with no heading at all, as the reference for what
    // "highlighted" resolves to on this page.
    vi.setSystemTime(new Date(2026, 8, 5, 23, 55))
    const plain = mountLog([{ title: 'Artist - Tonight', at: at(5, 23, 50) }])
    expect(plain.find('.title-log__day').exists()).toBe(false)

    expect(newestTrackColor(dated)).toBe(newestTrackColor(plain))
  })
})

describe('the search field', () => {
  /** A real browser because the thing being checked only exists once the
   * scoped rule is applied and resolved: what a phone browser reads to
   * decide whether to zoom the page in is the input's *computed* font
   * size, and jsdom computes none. Below 16px iOS Safari zooms on focus
   * and does not zoom back out when the field closes, leaving the whole
   * log oversized. */
  it('gives the input at least the 16px a phone needs to leave the page alone', async () => {
    const wrapper = mountLog([{ title: 'Oasis - Wonderwall', at: at(6, 20) }])

    await wrapper.find('.title-log__head button').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 50))

    const input = document.querySelector('.title-log__search-field input') as HTMLInputElement
    expect(parseFloat(getComputedStyle(input).fontSize)).toBeGreaterThanOrEqual(16)
  })

  it('sits above the scrolling log, so an arriving title cannot push it away', async () => {
    const wrapper = mountLog([{ title: 'Oasis - Wonderwall', at: at(6, 20) }])

    await wrapper.find('.title-log__head button').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 50))

    const field = document.querySelector('.title-log__search-field') as HTMLElement
    const scroller = document.querySelector('.title-log__scroll') as HTMLElement
    expect(scroller.contains(field)).toBe(false)
    expect(field.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      scroller.getBoundingClientRect().top + 1,
    )
  })
})
