import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { isMobileWebNow } from '@/composables/useIsMobileWeb'
import RadioTitleLog from '../RadioTitleLog.vue'

vi.mock('@/composables/useIsMobileWeb', () => ({ isMobileWebNow: vi.fn(() => false) }))

const push = vi.fn()

// The component renders a v-timeline, so the plugin has to be here even in
// jsdom: without it the timeline items resolve to nothing and these tests
// would be asserting against markup the app never renders.
const vuetify = createVuetify({ components, directives })

const i18n = {
  global: {
    plugins: [vuetify],
    mocks: { $t: (key: string) => key, $router: { push } },
  },
}

// `transition-group` is stubbed by @vue/test-utils out of the box, which
// replaces it with a wrapper element - and this component relies on it
// rendering as a fragment so the timeline items stay direct children of the
// timeline's grid. Testing against the stub would test a DOM the app never
// has, so it is switched off here and in the layout suite next door.
const realTransitions = { stubs: { transition: false, 'transition-group': false } }

beforeEach(() => {
  push.mockClear()
  vi.mocked(isMobileWebNow).mockReturnValue(false)
  // Every entry below carries a real date (see at()), and what "today" is
  // decides whether a date heading is written above it - which pushes each
  // timeline item down by one and breaks assertions that count them. Frozen
  // here so the suite reads the same on every day it runs rather than only
  // on the day it was written; the tests that need a different "now" set
  // their own on top of this one.
  vi.setSystemTime(new Date(2026, 8, 6, 12, 30))
})

afterEach(() => vi.useRealTimers())

function mountLog(titles: string[]) {
  return mount(RadioTitleLog, {
    props: { entries: titles.map((title, i) => ({ title, at: 1_757_000_000 + i })) },
    global: { ...i18n.global, ...realTransitions },
  })
}

/** Local-time helper, so these read as wall-clock moments rather than as
 * epoch arithmetic — and so they don't depend on the runner's timezone. */
function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 8, day, hour, minute).getTime() / 1000
}

function mountEntries(entries: { title: string; at: number }[]) {
  return mount(RadioTitleLog, {
    props: { entries },
    global: { ...i18n.global, ...realTransitions },
  })
}

function lines(wrapper: ReturnType<typeof mountEntries>): string[] {
  return wrapper.findAll('.title-log__day, .title-log__text').map((el) => el.text())
}

describe('RadioTitleLog', () => {
  it('splits an "Artist - Track" title into its two parts', () => {
    const wrapper = mountLog(['WizTheMc, bees & honey - Show Me Love'])

    expect(wrapper.find('.title-log__artist').text()).toBe('WizTheMc, bees & honey')
    expect(wrapper.find('.title-log__track').text()).toBe('Show Me Love')
    expect(wrapper.find('.title-log__plain').exists()).toBe(false)
  })

  it('shows a title that is not shaped like a song as one plain line', () => {
    // A real news item, sampled from Deutschlandfunk on 2026-09-05.
    const wrapper = mountLog([
      'Politikwissenschaftler Thorsten Faas, FU Berlin, zum BSW, Jonas Reese',
    ])

    expect(wrapper.find('.title-log__plain').exists()).toBe(true)
    expect(wrapper.find('.title-log__artist').exists()).toBe(false)
  })

  it('does not tear a hyphenated word in half', () => {
    // "ARD-Infosamstag", a programme name WDR 5 really sends — the reason
    // the separator requires spaces around the dash.
    const wrapper = mountLog(['ARD-Infosamstag'])

    expect(wrapper.find('.title-log__plain').text()).toBe('ARD-Infosamstag')
  })

  it('keeps a headline that happens to carry the song separator', () => {
    // "Deutschlandfunk - Alles von Relevanz" is a station slogan with the
    // exact shape of a song. It is shown as one, deliberately: no rule
    // drops it without dropping real songs too, so nothing is filtered.
    const wrapper = mountLog(['Deutschlandfunk - Alles von Relevanz'])

    expect(wrapper.find('.title-log__artist').text()).toBe('Deutschlandfunk')
    expect(wrapper.find('.title-log__track').text()).toBe('Alles von Relevanz')
  })

  it('renders every entry in the order it was given', () => {
    const wrapper = mountLog(['Newest', 'Middle', 'Oldest'])

    expect(wrapper.findAll('.title-log__item').map((i) => i.text())).toHaveLength(3)
    expect(wrapper.findAll('.title-log__plain').map((i) => i.text())).toEqual([
      'Newest',
      'Middle',
      'Oldest',
    ])
  })

  it('searches the library for a song row, by its track title', () => {
    const wrapper = mountLog(['WizTheMc, bees & honey - Show Me Love'])

    // The whole card, not the title on it - see the component's template
    // for why a row-sized target beats a text-sized one.
    wrapper.find('.title-log__item--searchable').trigger('click')

    // The track alone, not "artist track": an ICY artist field routinely
    // carries what a library never matches on, and a combined query that
    // misses reads as "you don't have this song".
    expect(push).toHaveBeenCalledWith({ name: 'search', query: { q: 'Show Me Love' } })
  })

  it('goes to the phone library rather than the desktop search page on mobile', () => {
    // The desktop search page does render inside the mobile shell, which
    // is how a tap on the phone landed on a view built for a window.
    vi.mocked(isMobileWebNow).mockReturnValue(true)
    const wrapper = mountLog(['WizTheMc, bees & honey - Show Me Love'])

    wrapper.find('.title-log__item--searchable').trigger('click')

    expect(push).toHaveBeenCalledWith({ name: 'm-library', query: { q: 'Show Me Love' } })
  })

  it('offers no search on a row that is not a song', () => {
    const wrapper = mountLog(['Informationen am Morgen'])

    expect(wrapper.find('.title-log__item--searchable').exists()).toBe(false)
    // Not a <button> either: a card that cannot do anything must not read
    // as one that can.
    expect(wrapper.find('button').exists()).toBe(false)
  })

  describe('a break in the listening', () => {
    /** Nothing logged for a long while means the station was off or
     * something else was playing - drawn as a gap so an evening reads as
     * the sittings it was. */
    it('marks the entry after a long silence', () => {
      const wrapper = mountEntries([
        { title: 'Artist - After the break', at: at(6, 12, 0) },
        { title: 'Artist - Before the break', at: at(6, 11, 0) },
      ])

      const items = wrapper.findAll('.v-timeline-item')
      expect(items[0]!.classes()).not.toContain('title-log__break')
      expect(items[1]!.classes()).toContain('title-log__break')
    })

    it('leaves an ordinary run of titles alone', () => {
      // Four minutes apart is a station playing one song after another.
      const wrapper = mountEntries([
        { title: 'Artist - Newer', at: at(6, 12, 0) },
        { title: 'Artist - Older', at: at(6, 11, 56) },
      ])

      expect(wrapper.findAll('.v-timeline-item')[1]!.classes()).not.toContain('title-log__break')
    })

    it('does not add one under a date heading, which already separates them', () => {
      vi.setSystemTime(new Date(2026, 8, 6, 12, 30))
      const wrapper = mountEntries([
        { title: 'Artist - This morning', at: at(6, 8, 0) },
        { title: 'Artist - Last night', at: at(5, 23, 0) },
      ])

      const items = wrapper.findAll('.v-timeline-item')
      // heading, then the entry it introduces
      expect(items[1]!.find('.title-log__day').exists()).toBe(true)
      expect(items[2]!.classes()).not.toContain('title-log__break')
    })
  })

  describe('when the log runs past midnight', () => {
    afterEach(() => vi.useRealTimers())

    function freezeOn(day: number, hour: number) {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 8, day, hour, 30))
    }

    it('adds no date heading while everything is from today', () => {
      freezeOn(5, 22)
      const wrapper = mountEntries([
        { title: 'Late one', at: at(5, 21, 50) },
        { title: 'Earlier one', at: at(5, 9, 15) },
      ])

      expect(wrapper.findAll('.title-log__day')).toHaveLength(0)
      expect(lines(wrapper)).toEqual(['Late one', 'Earlier one'])
    })

    it('separates yesterday from today, so two 23:50 rows are not the same', () => {
      freezeOn(6, 8)
      const wrapper = mountEntries([
        { title: 'Tonight', at: at(6, 0, 5) },
        { title: 'Last night', at: at(5, 23, 50) },
      ])

      expect(lines(wrapper)).toEqual(['Tonight', 'radio.titleLogYesterday', 'Last night'])
    })

    it('labels the top of a log whose newest entry is not from today either', () => {
      // The station stopped last night but the app stayed open — without a
      // heading here the whole list reads as today's.
      freezeOn(6, 8)
      const wrapper = mountEntries([{ title: 'Last night', at: at(5, 23, 50) }])

      expect(lines(wrapper)).toEqual(['radio.titleLogYesterday', 'Last night'])
    })

    it('names the day outright once it is further back than yesterday', () => {
      freezeOn(6, 8)
      const wrapper = mountEntries([{ title: 'Thursday night', at: at(3, 20, 0) }])

      const heading = wrapper.find('.title-log__day').text()
      expect(heading).not.toBe('radio.titleLogYesterday')
      // Locale-formatted, so assert on what it must contain rather than on
      // one language's exact wording.
      expect(heading).toContain('3')
    })
  })

  it('marks what is playing and what is not a song, and leaves songs plain', () => {
    const wrapper = mountEntries([
      { title: 'Years & Years - Eyes Shut', at: at(6, 11, 59) },
      { title: 'Mark Forster - Übermorgen', at: at(6, 11, 48) },
      { title: 'Informationen am Morgen', at: at(6, 11, 19) },
    ])

    const dots = wrapper.findAll('.v-timeline-divider__dot')
    expect(dots).toHaveLength(3)
    // Playing right now.
    expect(dots[0]!.find('.mdi-play').exists()).toBe(true)
    // An ordinary song in the log - an icon on every row would be texture
    // rather than information. Vuetify renders an (empty) icon element
    // either way, so what is asserted is that it carries no glyph.
    expect(dots[1]!.find('.mdi-play').exists()).toBe(false)
    expect(dots[1]!.find('.mdi-text-short').exists()).toBe(false)
    // Not shaped like a song: a programme name, a news item, a slogan.
    // A neutral text glyph rather than the microphone this used to be -
    // what the mark is built on is the missing " - ", which is not the
    // same claim as "this is speech" (see dotIcon()).
    expect(dots[2]!.find('.mdi-text-short').exists()).toBe(true)
    expect(dots[2]!.find('.mdi-microphone').exists()).toBe(false)
  })

  it('gives an entry a dot on the line and a date heading none', () => {
    vi.setSystemTime(new Date(2026, 8, 6, 8, 30))
    const wrapper = mountEntries([{ title: 'Artist - Last night', at: at(5, 23, 50) }])

    // The heading is a break in the line, not something that played at the
    // start of a day - see the component's own template.
    const items = wrapper.findAll('.v-timeline-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.find('.title-log__day').exists()).toBe(true)
    expect(items[0]!.find('.v-timeline-divider__dot').exists()).toBe(false)
    expect(items[1]!.find('.v-timeline-divider__dot').exists()).toBe(true)
  })

  describe('asking for older entries as the end comes into reach', () => {
    /** jsdom lays nothing out, so a scroller's own metrics are all 0 and
     * every scroll would read as "at the end". These are the numbers a
     * real box would report; the real thing is measured in
     * RadioTitleLog.scroll.layout.browser.test.ts. */
    function scrollTo(
      wrapper: ReturnType<typeof mountEntries>,
      {
        scrollTop,
        scrollHeight = 4000,
        clientHeight = 800,
      }: { scrollTop: number; scrollHeight?: number; clientHeight?: number },
    ) {
      const el = wrapper.find('.title-log__scroll').element as HTMLElement
      Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
      Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
      el.scrollTop = scrollTop
      return wrapper.find('.title-log__scroll').trigger('scroll')
    }

    function mountWithMore(hasMore: boolean) {
      return mount(RadioTitleLog, {
        props: {
          entries: [{ title: 'Artist - Track', at: 1_757_000_000 }],
          hasMore,
        },
        ...i18n,
      })
    }

    it('asks for more before the last row is reached, not once it is', async () => {
      const wrapper = mountWithMore(true)

      // 3400 of 4000 scrolled past with an 800px box: 600px per screenful
      // still below, which is inside the reach that counts as running out.
      await scrollTo(wrapper, { scrollTop: 2600 })

      expect(wrapper.emitted('load-more')).toHaveLength(1)
    })

    it('stays quiet while there is still plenty below', async () => {
      const wrapper = mountWithMore(true)

      await scrollTo(wrapper, { scrollTop: 200 })

      expect(wrapper.emitted('load-more')).toBeUndefined()
    })

    it('asks for nothing once the log is complete', async () => {
      const wrapper = mountWithMore(false)

      await scrollTo(wrapper, { scrollTop: 3200 })

      expect(wrapper.emitted('load-more')).toBeUndefined()
    })

    it('asks again on the next scroll, leaving the throttling to the store', async () => {
      // Deliberate: the store's own loadOlderRadioTitles() is a no-op
      // while a page is in flight, and a guard here would be a second one
      // that can fall out of step with the request it guards.
      const wrapper = mountWithMore(true)

      await scrollTo(wrapper, { scrollTop: 2600 })
      await scrollTo(wrapper, { scrollTop: 2800 })

      expect(wrapper.emitted('load-more')).toHaveLength(2)
    })
  })

  it('says so when the station has not played anything yet', () => {
    const wrapper = mount(RadioTitleLog, { props: { entries: [] }, ...i18n })

    expect(wrapper.find('.title-log__empty').text()).toBe('radio.titleLogEmpty')
    expect(wrapper.find('.title-log__list').exists()).toBe(false)
  })
})

/** The entrance is armed for exactly one kind of change - a title the
 * station has just started, arriving at the top - and stays off for the
 * two that would otherwise animate a whole screenful at once. The
 * animation itself is CSS and needs no test; which change gets it is
 * ordinary logic and does. */
describe('RadioTitleLog new-title animation', () => {
  const at = (hour: number, minute: number) => new Date(2026, 8, 6, hour, minute).getTime() / 1000

  const older = [
    { title: 'Artist - Second', at: at(11, 51) },
    { title: 'Artist - Third', at: at(11, 42) },
  ]

  /** Read off the transition group itself rather than off the component's
   * own flag: what matters is that the switch actually reaches the thing
   * doing the animating. */
  function armed(wrapper: ReturnType<typeof mountEntries>): boolean {
    return wrapper.findComponent({ name: 'TransitionGroup' }).props('css') as boolean
  }

  it('does not animate its very first render', () => {
    const wrapper = mountEntries(older)

    expect(armed(wrapper)).toBe(false)
  })

  it('animates a title arriving at the top', async () => {
    const wrapper = mountEntries(older)

    await wrapper.setProps({ entries: [{ title: 'Artist - Newest', at: at(11, 59) }, ...older] })

    expect(armed(wrapper)).toBe(true)
  })

  it('stays still when a page of older entries is appended', async () => {
    const wrapper = mountEntries(older)

    await wrapper.setProps({ entries: [...older, { title: 'Artist - Older', at: at(10, 4) }] })

    expect(armed(wrapper)).toBe(false)
  })

  it('stays still when the whole list is replaced, as on a station switch', async () => {
    const wrapper = mountEntries(older)

    await wrapper.setProps({
      entries: [
        { title: 'Other - A', at: at(12, 1) },
        { title: 'Other - B', at: at(12, 0) },
        { title: 'Other - C', at: at(11, 58) },
      ],
    })

    expect(armed(wrapper)).toBe(false)
  })

  /** The transition group must not bring a wrapper element with it: the
   * timeline is a grid and its items have to stay direct children of it. */
  it('leaves the timeline items as direct children of the timeline', () => {
    const wrapper = mountEntries(older)

    const children = [...wrapper.get('.v-timeline').element.children]
    expect(children.length).toBeGreaterThan(0)
    for (const child of children) {
      expect(child.classList.contains('v-timeline-item')).toBe(true)
    }
  })
})
