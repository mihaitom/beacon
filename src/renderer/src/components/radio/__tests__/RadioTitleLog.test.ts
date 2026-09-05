import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { isMobileWebNow } from '@/composables/useIsMobileWeb'
import RadioTitleLog from '../RadioTitleLog.vue'

vi.mock('@/composables/useIsMobileWeb', () => ({ isMobileWebNow: vi.fn(() => false) }))

const push = vi.fn()

const i18n = {
  global: {
    mocks: { $t: (key: string) => key, $router: { push } },
  },
}

beforeEach(() => {
  push.mockClear()
  vi.mocked(isMobileWebNow).mockReturnValue(false)
})

function mountLog(titles: string[]) {
  return mount(RadioTitleLog, {
    props: { entries: titles.map((title, i) => ({ title, at: 1_757_000_000 + i })) },
    ...i18n,
  })
}

/** Local-time helper, so these read as wall-clock moments rather than as
 * epoch arithmetic — and so they don't depend on the runner's timezone. */
function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 8, day, hour, minute).getTime() / 1000
}

function mountEntries(entries: { title: string; at: number }[]) {
  return mount(RadioTitleLog, { props: { entries }, ...i18n })
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

    wrapper.find('.title-log__text--searchable').trigger('click')

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

    wrapper.find('.title-log__text--searchable').trigger('click')

    expect(push).toHaveBeenCalledWith({ name: 'm-library', query: { q: 'Show Me Love' } })
  })

  it('offers no search on a row that is not a song', () => {
    const wrapper = mountLog(['Informationen am Morgen'])

    expect(wrapper.find('.title-log__text--searchable').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
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

  it('says so when the station has not played anything yet', () => {
    const wrapper = mount(RadioTitleLog, { props: { entries: [] }, ...i18n })

    expect(wrapper.find('.title-log__empty').text()).toBe('radio.titleLogEmpty')
    expect(wrapper.find('.title-log__list').exists()).toBe(false)
  })
})
