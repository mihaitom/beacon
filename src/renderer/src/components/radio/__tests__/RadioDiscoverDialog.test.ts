// The station-search dialog, lifted out of RadioView.vue's own tests when
// it became a component of its own — shared now by the desktop Radio page
// and the phone's (see the component's own comment for why that one piece
// is shared while the two pages are not).
//
// The behaviour these pin down is all about not asking Radio Browser's
// third-party API more than necessary: one search per opening, one per
// deliberate filter change, and a debounce on typing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { emitter } from '@/emitter'
import RadioDiscoverDialog from '../RadioDiscoverDialog.vue'
import * as radioBrowser from '@/services/connect/radioBrowser'
import { radioBrowserIdFor } from '@/services/radioBrowserLinks'
import type { RadioBrowserStation } from '@/services/connect/radioBrowser'

vi.mock('@/services/connect/radioBrowser', () => ({
  searchRadioBrowser: vi.fn(),
  listRadioBrowserCountries: vi.fn(),
  registerRadioBrowserClick: vi.fn(),
  voteForRadioBrowserStation: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })

interface DialogInstance {
  browseQuery: string
  browseCountry: string | null
  browseOrder: 'votes' | 'clickcount'
  countryOptions: { name: string; code: string }[]
  countryItems: { name?: string; code?: string; type?: string }[]
  addBrowsedStation(result: RadioBrowserStation): Promise<void>
  voteForStation(result: RadioBrowserStation): Promise<void>
}

function makeResult(overrides: Partial<RadioBrowserStation> = {}): RadioBrowserStation {
  return {
    stationuuid: 'uuid-1',
    name: 'Example FM',
    url: 'http://example.com/stream',
    homepage: 'https://example.com',
    favicon: 'https://example.com/favicon.ico',
    country: 'Germany',
    state: 'Bavaria',
    languagecodes: 'en,de',
    tags: 'pop,rock',
    codec: 'MP3',
    bitrate: 128,
    votes: 42,
    clickcount: 7,
    clicktrend: -2,
    lastcheckok: true,
    ...overrides,
  }
}

function mountDialog() {
  return mount(RadioDiscoverDialog, {
    props: { modelValue: false },
    global: {
      plugins: [vuetify, i18n],
      stubs: { CoverArt: true },
      // The dialog reports a refused or failed vote as a toast — see its
      // own voteForStation().
      mocks: { $emitter: emitter },
    },
    // v-dialog teleports its content out of the component tree — without
    // this it is beyond both the wrapper's and document.querySelector's
    // reach.
    attachTo: document.body,
  })
}

function instanceOf(wrapper: ReturnType<typeof mountDialog>): DialogInstance {
  return wrapper.vm as unknown as DialogInstance
}

/** Opens the dialog and lets its own immediate (non-debounced) initial
 * browse settle — every test starts from here, since opening always fires
 * exactly one (see the component's own onOpened()). */
async function openAndSettle(wrapper: ReturnType<typeof mountDialog>) {
  await wrapper.setProps({ modelValue: true })
  await flushPromises()
}

/** The vote figure is the vote button — see the component's own template
 * for why the number and the control that raises it are one target. */
function voteButton(): HTMLElement {
  return document.querySelector('.discover-results .discover-card__stat--vote')!
}

/** Closing and opening again, which is what the page does — the dialog is
 * driven by its `modelValue`, not by a method of its own. */
async function reopenAndSettle(wrapper: ReturnType<typeof mountDialog>) {
  await wrapper.setProps({ modelValue: false })
  await openAndSettle(wrapper)
}

describe('RadioDiscoverDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // browseCountry is persisted to localStorage (see this component's own
    // saveBrowseCountry()) — without clearing it, a selection made in one
    // test would leak into the next test's fresh mount.
    localStorage.clear()
    vi.useFakeTimers()
    vi.mocked(radioBrowser.searchRadioBrowser).mockReset().mockResolvedValue([])
    vi.mocked(radioBrowser.listRadioBrowserCountries).mockReset().mockResolvedValue([])
    vi.mocked(radioBrowser.registerRadioBrowserClick).mockReset()
    vi.mocked(radioBrowser.voteForRadioBrowserStation).mockReset().mockResolvedValue(true)
    vi.spyOn(useLibraryStore(), 'saveRadioStation').mockResolvedValue()
    vi.spyOn(usePlaybackStore(), 'playRadioStation').mockResolvedValue()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  /** Plays rather than votes: a vote has to be cast by hand and so favours
   * whoever has been listed longest, while the play count is what people
   * actually listened to. */
  it('browses the most-played stations immediately on open, before anything is typed', async () => {
    const wrapper = mountDialog()
    await openAndSettle(wrapper)

    expect(radioBrowser.searchRadioBrowser).toHaveBeenCalledWith({
      name: '',
      countrycodes: [],
      order: 'clickcount',
    })
  })

  it('loads the country picker once and keeps it for the rest of the session', async () => {
    vi.mocked(radioBrowser.listRadioBrowserCountries).mockResolvedValue([
      { name: 'Germany', code: 'DE' },
    ])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)

    expect(instanceOf(wrapper).countryOptions).toEqual([{ name: 'Germany', code: 'DE' }])

    await reopenAndSettle(wrapper)
    await flushPromises()

    expect(radioBrowser.listRadioBrowserCountries).toHaveBeenCalledOnce()
  })

  it('fires exactly one search on reopen, even after a non-default query/order last time', async () => {
    // browseQuery/browseOrder both reset to their defaults in
    // openBrowse(), and both are watched — a search that a watcher fired
    // off the back of that reset (only observable when the previous
    // value was non-default, i.e. actually changed) used to run
    // alongside openBrowse()'s own explicit call, on top of whichever
    // debounced browseQuery search was still pending.
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    instanceOf(wrapper).browseQuery = 'jazz'
    await vi.advanceTimersByTimeAsync(400)
    instanceOf(wrapper).browseOrder = 'votes'
    await flushPromises()
    vi.mocked(radioBrowser.searchRadioBrowser).mockClear()

    await reopenAndSettle(wrapper)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(400)

    expect(radioBrowser.searchRadioBrowser).toHaveBeenCalledTimes(1)
    expect(radioBrowser.searchRadioBrowser).toHaveBeenCalledWith({
      name: '',
      countrycodes: [],
      order: 'clickcount',
    })
  })

  it('does not search again until the typing debounce settles', async () => {
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    vi.mocked(radioBrowser.searchRadioBrowser).mockClear()

    instanceOf(wrapper).browseQuery = 'jazz'
    await wrapper.vm.$nextTick()
    expect(radioBrowser.searchRadioBrowser).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(400)
    expect(radioBrowser.searchRadioBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'jazz' }),
    )
  })

  it('searches immediately (no debounce) when the country filter changes', async () => {
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    vi.mocked(radioBrowser.searchRadioBrowser).mockClear()

    instanceOf(wrapper).browseCountry = 'DE'
    await wrapper.vm.$nextTick()
    expect(radioBrowser.searchRadioBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ countrycodes: ['DE'] }),
    )
  })

  it('remembers the selected country across a remount', async () => {
    const first = mountDialog()
    await reopenAndSettle(first)
    await flushPromises()
    instanceOf(first).browseCountry = 'DE'
    await flushPromises()
    first.unmount()

    const second = mountDialog()
    await openAndSettle(second)

    expect(instanceOf(second).browseCountry).toBe('DE')
  })

  /** The three countries somebody listens to are one glance away instead
   * of one scroll through the ~250 the directory has, and the divider is
   * what says where that block ends. */
  it('pins the countries picked before, most recent first, above a divider', async () => {
    vi.mocked(radioBrowser.listRadioBrowserCountries).mockResolvedValue([
      { name: 'Austria', code: 'AT' },
      { name: 'France', code: 'FR' },
      { name: 'Germany', code: 'DE' },
    ])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)

    instanceOf(wrapper).browseCountry = 'DE'
    await flushPromises()
    instanceOf(wrapper).browseCountry = 'FR'
    await flushPromises()

    expect(instanceOf(wrapper).countryItems).toEqual([
      { name: 'France', code: 'FR' },
      { name: 'Germany', code: 'DE' },
      { type: 'divider', name: '', code: '' },
      { name: 'Austria', code: 'AT' },
    ])
  })

  /** Moved up, not copied: a country listed twice would show up twice
   * while typing filters the picker, and both rows would be drawn as the
   * selected one. */
  it('leaves the picker untouched while nothing has been picked yet', async () => {
    vi.mocked(radioBrowser.listRadioBrowserCountries).mockResolvedValue([
      { name: 'Austria', code: 'AT' },
      { name: 'Germany', code: 'DE' },
    ])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)

    expect(instanceOf(wrapper).countryItems).toEqual([
      { name: 'Austria', code: 'AT' },
      { name: 'Germany', code: 'DE' },
    ])
  })

  it('keeps the pinned countries across a remount, and clearing the filter does not drop them', async () => {
    vi.mocked(radioBrowser.listRadioBrowserCountries).mockResolvedValue([
      { name: 'Austria', code: 'AT' },
      { name: 'Germany', code: 'DE' },
    ])
    const first = mountDialog()
    await openAndSettle(first)
    instanceOf(first).browseCountry = 'DE'
    await flushPromises()
    // The picker's own clear button — "no country" is not a country that
    // was picked, so it must not empty the pinned block.
    instanceOf(first).browseCountry = null
    await flushPromises()
    first.unmount()

    const second = mountDialog()
    await openAndSettle(second)

    expect(instanceOf(second).countryItems).toEqual([
      { name: 'Germany', code: 'DE' },
      { type: 'divider', name: '', code: '' },
      { name: 'Austria', code: 'AT' },
    ])
  })

  it('searches immediately when the order toggle changes', async () => {
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    vi.mocked(radioBrowser.searchRadioBrowser).mockClear()

    // Away from the default, or the watcher has nothing to react to and
    // this would pass on the search the dialog already made on open.
    instanceOf(wrapper).browseOrder = 'votes'
    await wrapper.vm.$nextTick()

    expect(radioBrowser.searchRadioBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ order: 'votes' }),
    )
  })

  it('renders results and lets one be added, remembering where it came from', async () => {
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult()])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    await wrapper.vm.$nextTick()

    expect(document.body.textContent).toContain('Example FM')

    document.querySelector('.discover-results .mdi-plus')!.closest('button')!.click()
    await flushPromises()

    expect(useLibraryStore().saveRadioStation).toHaveBeenCalledWith(
      'Example FM',
      'http://example.com/stream',
      'https://example.com',
    )
    // Not reported here: to Radio Browser a click means someone listened,
    // and adding a station is not listening. The link left behind is what
    // lets every later play of it be reported instead - see
    // services/radioBrowserLinks.ts.
    expect(radioBrowser.registerRadioBrowserClick).not.toHaveBeenCalled()
    expect(radioBrowserIdFor('http://example.com/stream')).toBe('uuid-1')
  })

  it('ignores a second add while the first save is still in flight', async () => {
    // The add button has no disabled state of its own until this fix —
    // a double-click/double-tap before the first saveRadioStation() call
    // resolved fired a second, concurrent one, creating a duplicate
    // saved station for the same result.
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult()])
    let resolveSave: () => void = () => {}
    vi.spyOn(useLibraryStore(), 'saveRadioStation').mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve
      }),
    )
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    await wrapper.vm.$nextTick()

    const result = makeResult()
    const first = instanceOf(wrapper).addBrowsedStation(result)
    const second = instanceOf(wrapper).addBrowsedStation(result)
    resolveSave()
    await Promise.all([first, second])

    expect(useLibraryStore().saveRadioStation).toHaveBeenCalledTimes(1)
  })

  it('plays a result directly without saving it', async () => {
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult()])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    await wrapper.vm.$nextTick()

    ;(document.querySelector('.discover-card__art') as HTMLElement).click()
    await flushPromises()

    expect(usePlaybackStore().playRadioStation).toHaveBeenCalledWith({
      id: 'uuid-1',
      name: 'Example FM',
      streamUrl: 'http://example.com/stream',
      homePageUrl: 'https://example.com',
      favicon: 'https://example.com/favicon.ico',
    })
    // The link is recorded here too, so the store reports this listen the
    // same way it reports one of a saved station - one place doing the
    // reporting rather than two (playRadioStation is stubbed above, which
    // is why no click is asserted here).
    expect(radioBrowserIdFor('http://example.com/stream')).toBe('uuid-1')
    expect(useLibraryStore().saveRadioStation).not.toHaveBeenCalled()
  })

  it('credits Radio Browser with a link to its own site', async () => {
    const wrapper = mountDialog()
    await openAndSettle(wrapper)

    const credit = document.querySelector('.discover-credit') as HTMLAnchorElement | null
    expect(credit?.href).toBe('https://www.radio-browser.info/')
    expect(credit?.target).toBe('_blank')
  })

  it('passes the Radio Browser favicon along as a hint to the favicon proxy', async () => {
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([
      makeResult({ favicon: 'https://cdn.example/icon.png' }),
    ])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    await wrapper.vm.$nextTick()

    // Not the first CoverArt in the tree — DetailHeader.vue's own hero
    // renders one too (its plain fallback-icon, no radioFavicon prop at
    // all), so this picks out the browse table's own by the prop under
    // test actually being set.
    const coverArt = wrapper
      .findAllComponents({ name: 'CoverArt' })
      .find((c) => c.props('radioFavicon') != null)!
    expect(coverArt.props('radioFavicon')).toEqual({
      homePageUrl: 'https://example.com',
      hint: 'https://cdn.example/icon.png',
      // 48 rounded up to the small step, so every list row in the app
      // shares one lookup per station — see faviconSizeStep().
      minSize: 64,
    })
  })

  it('gives a long station name a single line, truncated, with the full name in a tooltip', async () => {
    const longName = 'A'.repeat(120)
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult({ name: longName })])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    await wrapper.vm.$nextTick()

    const nameLink = document.querySelector('.discover-card__name') as HTMLElement | null
    expect(nameLink?.title).toBe(longName)

    // Whether it actually stays on one line is a question about applied
    // CSS, which jsdom does not do at all — that half is asserted for
    // real in RadioView.discover.layout.browser.test.ts.
  })

  it('shows the location, language, codec, popularity and homepage of a station', async () => {
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult()])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    await wrapper.vm.$nextTick()

    // All three now share one line under the name instead of a column
    // each — see RadioView.vue's metaFor().
    expect(document.querySelector('.discover-card__meta')!.textContent).toBe(
      'Germany · Bavaria · EN,DE · MP3, 128 kbps',
    )
    expect(document.body.textContent).toContain('42') // votes
    expect(document.body.textContent).toContain('7') // clicks (24h)
    expect(document.body.textContent).toContain('(-2)') // clicktrend
    expect(
      document.querySelector('.discover-results [title="Online at last check"]'),
    ).not.toBeNull()
    const homepageLink = document.querySelector(
      '.discover-results a[href="https://example.com"]',
    ) as HTMLAnchorElement | null
    expect(homepageLink?.target).toBe('_blank')
  })

  it('omits the bitrate for a station Radio Browser has none for', async () => {
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult({ bitrate: null })])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    await wrapper.vm.$nextTick()

    expect(document.body.textContent).toContain('MP3')
    expect(document.body.textContent).not.toContain('MP3,')
  })

  it('flags a station that failed its last health check', async () => {
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([
      makeResult({ lastcheckok: false }),
    ])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    await wrapper.vm.$nextTick()

    expect(
      document.querySelector('.discover-results [title="Offline at last check"]'),
    ).not.toBeNull()
  })

  it('shows a checkmark instead of the add button once a result has been added', async () => {
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult()])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    await wrapper.vm.$nextTick()

    document.querySelector('.discover-results .mdi-plus')!.closest('button')!.click()
    await flushPromises()

    expect(document.querySelector('.discover-results .mdi-plus')).toBeNull()
    expect(document.querySelector('.discover-results .mdi-check')).not.toBeNull()
  })

  it('casts a vote for a station and raises the figure that button sits on', async () => {
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult({ votes: 42 })])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    await wrapper.vm.$nextTick()

    voteButton().click()
    await flushPromises()

    expect(radioBrowser.voteForRadioBrowserStation).toHaveBeenCalledWith('uuid-1')
    expect(voteButton().textContent).toContain('43')
    // Filled thumb, and no second vote to give — one per station per day.
    expect(voteButton().querySelector('.mdi-thumb-up')).not.toBeNull()
    expect((voteButton() as HTMLButtonElement).disabled).toBe(true)
  })

  it('never spends a second vote while the first is still in flight', async () => {
    // Through the method rather than the button: the button disables
    // itself for the round trip, so a second *click* never reaches this
    // anyway — the guard is what keeps a vote from being cast twice by
    // anything else that can reach it.
    let resolveVote: (counted: boolean) => void = () => {}
    vi.mocked(radioBrowser.voteForRadioBrowserStation).mockImplementation(
      () => new Promise((resolve) => (resolveVote = resolve)),
    )
    const station = makeResult()
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([station])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)

    void instanceOf(wrapper).voteForStation(station)
    void instanceOf(wrapper).voteForStation(station)
    resolveVote(true)
    await flushPromises()

    expect(radioBrowser.voteForRadioBrowserStation).toHaveBeenCalledTimes(1)
    expect(station.votes).toBe(43)
  })

  it('has nothing left to send once a vote for that station is cast', async () => {
    const station = makeResult()
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([station])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)

    await instanceOf(wrapper).voteForStation(station)
    await instanceOf(wrapper).voteForStation(station)

    expect(radioBrowser.voteForRadioBrowserStation).toHaveBeenCalledTimes(1)
  })

  it('marks a refused vote as spent and says why, rather than reporting an error', async () => {
    vi.mocked(radioBrowser.voteForRadioBrowserStation).mockResolvedValue(false)
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult({ votes: 42 })])
    const toasts: { level: string; title: string }[] = []
    emitter.on('toast', (toast) => toasts.push(toast as { level: string; title: string }))
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    await wrapper.vm.$nextTick()

    voteButton().click()
    await flushPromises()
    emitter.all.clear()

    // The directory's own day's vote for this station is spent (by another
    // device, or another person on this Beacon server), so the button
    // closes — but the count it did not raise stays where it was.
    expect((voteButton() as HTMLButtonElement).disabled).toBe(true)
    expect(voteButton().textContent).toContain('42')
    expect(toasts).toEqual([
      expect.objectContaining({ level: 'information', title: 'Already voted today' }),
    ])
  })

  it('leaves the button open for another try when the vote could not be sent at all', async () => {
    vi.mocked(radioBrowser.voteForRadioBrowserStation).mockRejectedValue(new Error('unreachable'))
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult()])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const toasts: { level: string; title: string }[] = []
    emitter.on('toast', (toast) => toasts.push(toast as { level: string; title: string }))
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    await wrapper.vm.$nextTick()

    voteButton().click()
    await flushPromises()
    emitter.all.clear()

    expect((voteButton() as HTMLButtonElement).disabled).toBe(false)
    expect(toasts).toEqual([expect.objectContaining({ level: 'error', title: 'Vote not sent' })])
  })

  it('still shows a vote as cast after the dialog is closed and opened again', async () => {
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult()])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    await wrapper.vm.$nextTick()
    voteButton().click()
    await flushPromises()

    await reopenAndSettle(wrapper)
    await wrapper.vm.$nextTick()

    expect((voteButton() as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows an error message when every mirror is unreachable', async () => {
    vi.mocked(radioBrowser.searchRadioBrowser).mockRejectedValue(new Error('unreachable'))
    const wrapper = mountDialog()
    await openAndSettle(wrapper)

    expect(document.body.textContent).toContain("Couldn't reach the station directory")
  })

  it('shows a no-results message naming the query for a genuinely empty text search', async () => {
    const wrapper = mountDialog()
    await openAndSettle(wrapper)

    instanceOf(wrapper).browseQuery = 'zzzzzz'
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(document.body.textContent).toContain('No stations found for "zzzzzz"')
  })

  it('shows a filter-only no-results message when no query was typed', async () => {
    const wrapper = mountDialog()
    await openAndSettle(wrapper)

    instanceOf(wrapper).browseCountry = 'DE'
    await flushPromises()

    expect(document.body.textContent).toContain('No stations found for these filters')
  })

  it('discards a stale response that resolves after a newer query already superseded it', async () => {
    let resolveFirst: (stations: RadioBrowserStation[]) => void = () => {}
    vi.mocked(radioBrowser.searchRadioBrowser).mockImplementation(
      ({ name } = {}) =>
        new Promise((resolve) => {
          if (name === 'first') resolveFirst = resolve
          else resolve([makeResult({ stationuuid: 'uuid-2', name: 'Second Result' })])
        }),
    )
    const wrapper = mountDialog()
    await openAndSettle(wrapper)

    instanceOf(wrapper).browseQuery = 'first'
    await vi.advanceTimersByTimeAsync(400)
    instanceOf(wrapper).browseQuery = 'second'
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    // The second query's own result has already landed — resolving the
    // first one now must not overwrite it with the stale answer.
    resolveFirst([makeResult({ stationuuid: 'uuid-1', name: 'First Result' })])
    await flushPromises()

    expect(document.body.textContent).toContain('Second Result')
    expect(document.body.textContent).not.toContain('First Result')
  })

  it('resets the query and order each time it is reopened, but keeps the country selection', async () => {
    vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult()])
    const wrapper = mountDialog()
    await openAndSettle(wrapper)
    instanceOf(wrapper).browseQuery = 'jazz'
    instanceOf(wrapper).browseCountry = 'DE'
    instanceOf(wrapper).browseOrder = 'votes'
    await flushPromises()
    expect(document.body.textContent).toContain('Example FM')

    vi.mocked(radioBrowser.searchRadioBrowser).mockClear()
    await reopenAndSettle(wrapper)
    await flushPromises()

    expect(instanceOf(wrapper).browseQuery).toBe('')
    expect(instanceOf(wrapper).browseCountry).toBe('DE')
    expect(instanceOf(wrapper).browseOrder).toBe('clickcount')
    expect(radioBrowser.searchRadioBrowser).toHaveBeenCalledWith({
      name: '',
      countrycodes: ['DE'],
      order: 'clickcount',
    })
  })
})
