import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import RadioView from '../RadioView.vue'
import * as radioBrowser from '@/services/connect/radioBrowser'
import type { RadioBrowserStation } from '@/services/connect/radioBrowser'

vi.mock('@/services/connect/radioBrowser', () => ({
  searchRadioBrowser: vi.fn(),
  listRadioBrowserCountries: vi.fn(),
  registerRadioBrowserClick: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })

interface RadioViewInstance {
  browseQuery: string
  browseCountry: string | null
  browseOrder: 'votes' | 'clickcount'
  browseDialog: boolean
  countryOptions: { name: string; code: string }[]
  openBrowse(): void
  addBrowsedStation(result: RadioBrowserStation): Promise<void>
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

function mountRadioView() {
  return mount(RadioView, {
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
    // v-dialog teleports its content out of the component tree — without
    // this it's beyond both the wrapper's and document.querySelector's
    // reach (see KeyboardShortcutsDialog.test.ts's identical comment).
    attachTo: document.body,
  })
}

function instanceOf(wrapper: ReturnType<typeof mountRadioView>): RadioViewInstance {
  return wrapper.vm as unknown as RadioViewInstance
}

/** Opens the dialog and lets its own immediate (non-debounced) initial
 * browse settle — every test starts from here, since openBrowse() always
 * fires one (see RadioView.vue's own comment on why). */
async function openAndSettle(wrapper: ReturnType<typeof mountRadioView>) {
  instanceOf(wrapper).openBrowse()
  await flushPromises()
}

describe('RadioView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // browseCountry is persisted to localStorage (see RadioView.vue's own
    // saveBrowseCountry()) — without clearing it, a selection made in one
    // test would leak into the next test's fresh mount.
    localStorage.clear()
    vi.useFakeTimers()
    vi.mocked(radioBrowser.searchRadioBrowser).mockReset().mockResolvedValue([])
    vi.mocked(radioBrowser.listRadioBrowserCountries).mockReset().mockResolvedValue([])
    vi.mocked(radioBrowser.registerRadioBrowserClick).mockReset()
    vi.spyOn(useLibraryStore(), 'fetchRadioStations').mockResolvedValue()
    vi.spyOn(useLibraryStore(), 'saveRadioStation').mockResolvedValue()
    vi.spyOn(usePlaybackStore(), 'playRadioStation').mockResolvedValue()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  describe('discover dialog', () => {
    it('browses top-voted stations immediately on open, before anything is typed', async () => {
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)

      expect(radioBrowser.searchRadioBrowser).toHaveBeenCalledWith({
        name: '',
        countrycodes: [],
        order: 'votes',
      })
    })

    it('loads the country picker once and keeps it for the rest of the session', async () => {
      vi.mocked(radioBrowser.listRadioBrowserCountries).mockResolvedValue([
        { name: 'Germany', code: 'DE' },
      ])
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)

      expect(instanceOf(wrapper).countryOptions).toEqual([{ name: 'Germany', code: 'DE' }])

      instanceOf(wrapper).openBrowse()
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
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)
      instanceOf(wrapper).browseQuery = 'jazz'
      await vi.advanceTimersByTimeAsync(400)
      instanceOf(wrapper).browseOrder = 'clickcount'
      await flushPromises()
      vi.mocked(radioBrowser.searchRadioBrowser).mockClear()

      instanceOf(wrapper).openBrowse()
      await flushPromises()
      await vi.advanceTimersByTimeAsync(400)

      expect(radioBrowser.searchRadioBrowser).toHaveBeenCalledTimes(1)
      expect(radioBrowser.searchRadioBrowser).toHaveBeenCalledWith({
        name: '',
        countrycodes: [],
        order: 'votes',
      })
    })

    it('does not search again until the typing debounce settles', async () => {
      const wrapper = mountRadioView()
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
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)
      vi.mocked(radioBrowser.searchRadioBrowser).mockClear()

      instanceOf(wrapper).browseCountry = 'DE'
      await wrapper.vm.$nextTick()
      expect(radioBrowser.searchRadioBrowser).toHaveBeenCalledWith(
        expect.objectContaining({ countrycodes: ['DE'] }),
      )
    })

    it('remembers the selected country across a remount', async () => {
      const first = mountRadioView()
      instanceOf(first).openBrowse()
      await flushPromises()
      instanceOf(first).browseCountry = 'DE'
      await flushPromises()
      first.unmount()

      const second = mountRadioView()
      await openAndSettle(second)

      expect(instanceOf(second).browseCountry).toBe('DE')
    })

    it('searches immediately when the order toggle changes', async () => {
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)
      vi.mocked(radioBrowser.searchRadioBrowser).mockClear()

      instanceOf(wrapper).browseOrder = 'clickcount'
      await wrapper.vm.$nextTick()

      expect(radioBrowser.searchRadioBrowser).toHaveBeenCalledWith(
        expect.objectContaining({ order: 'clickcount' }),
      )
    })

    it('renders results and lets one be added, reporting the click', async () => {
      vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult()])
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)
      await wrapper.vm.$nextTick()

      expect(document.body.textContent).toContain('Example FM')

      document.querySelector('.v-data-table .mdi-plus')!.closest('button')!.click()
      await flushPromises()

      expect(useLibraryStore().saveRadioStation).toHaveBeenCalledWith(
        'Example FM',
        'http://example.com/stream',
        'https://example.com',
      )
      expect(radioBrowser.registerRadioBrowserClick).toHaveBeenCalledWith('uuid-1')
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
      const wrapper = mountRadioView()
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
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)
      await wrapper.vm.$nextTick()

      ;(document.querySelector('.radio-view__browse-favicon') as HTMLElement).click()
      await flushPromises()

      expect(usePlaybackStore().playRadioStation).toHaveBeenCalledWith({
        id: 'uuid-1',
        name: 'Example FM',
        streamUrl: 'http://example.com/stream',
        homePageUrl: 'https://example.com',
        favicon: 'https://example.com/favicon.ico',
      })
      expect(radioBrowser.registerRadioBrowserClick).toHaveBeenCalledWith('uuid-1')
      expect(useLibraryStore().saveRadioStation).not.toHaveBeenCalled()
    })

    it('credits Radio Browser with a link to its own site', async () => {
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)

      const credit = document.querySelector(
        '.radio-view__browse-credit',
      ) as HTMLAnchorElement | null
      expect(credit?.href).toBe('https://www.radio-browser.info/')
      expect(credit?.target).toBe('_blank')
    })

    it('passes the Radio Browser favicon along as a hint to the favicon proxy', async () => {
      vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([
        makeResult({ favicon: 'https://cdn.example/icon.png' }),
      ])
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)
      await wrapper.vm.$nextTick()

      const coverArt = wrapper.findComponent({ name: 'CoverArt' })
      expect(coverArt.props('radioFavicon')).toEqual({
        homePageUrl: 'https://example.com',
        hint: 'https://cdn.example/icon.png',
        // 48 rounded up to the small step, so every list row in the app
        // shares one lookup per station — see faviconSizeStep().
        minSize: 64,
      })
    })

    it('gives a long station name a single-line, truncated cell with the full name in a tooltip', async () => {
      const longName = 'A'.repeat(120)
      vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult({ name: longName })])
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)
      await wrapper.vm.$nextTick()

      const nameLink = document.querySelector('.radio-view__browse-name-text') as HTMLElement | null
      expect(nameLink?.title).toBe(longName)

      // The tooltip/ellipsis alone don't stop an unbroken string of
      // content from stretching the cell itself past every other column —
      // see the "name" header's own maxWidth comment for why `width`
      // alone isn't enough to cap a table cell.
      const cell = nameLink!.closest('td') as HTMLElement
      expect(cell.style.maxWidth).toBe('260px')
    })

    it('shows the location, language, codec, popularity and homepage columns', async () => {
      vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult()])
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)
      await wrapper.vm.$nextTick()

      expect(document.body.textContent).toContain('Germany · Bavaria')
      expect(document.body.textContent).toContain('EN,DE')
      expect(document.body.textContent).toContain('MP3, 128 kbps')
      expect(document.body.textContent).toContain('42') // votes
      expect(document.body.textContent).toContain('7') // clicks (24h)
      expect(document.body.textContent).toContain('(-2)') // clicktrend
      expect(document.querySelector('.v-data-table [title="Online at last check"]')).not.toBeNull()
      const homepageLink = document.querySelector(
        '.v-data-table a[href="https://example.com"]',
      ) as HTMLAnchorElement | null
      expect(homepageLink?.target).toBe('_blank')
    })

    it('omits the bitrate for a station Radio Browser has none for', async () => {
      vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult({ bitrate: null })])
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)
      await wrapper.vm.$nextTick()

      expect(document.body.textContent).toContain('MP3')
      expect(document.body.textContent).not.toContain('MP3,')
    })

    it('flags a station that failed its last health check', async () => {
      vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([
        makeResult({ lastcheckok: false }),
      ])
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)
      await wrapper.vm.$nextTick()

      expect(document.querySelector('.v-data-table [title="Offline at last check"]')).not.toBeNull()
    })

    it('shows a checkmark instead of the add button once a result has been added', async () => {
      vi.mocked(radioBrowser.searchRadioBrowser).mockResolvedValue([makeResult()])
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)
      await wrapper.vm.$nextTick()

      document.querySelector('.v-data-table .mdi-plus')!.closest('button')!.click()
      await flushPromises()

      expect(document.querySelector('.v-data-table .mdi-plus')).toBeNull()
      expect(document.querySelector('.v-data-table .mdi-check')).not.toBeNull()
    })

    it('shows an error message when every mirror is unreachable', async () => {
      vi.mocked(radioBrowser.searchRadioBrowser).mockRejectedValue(new Error('unreachable'))
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)

      expect(document.body.textContent).toContain("Couldn't reach the station directory")
    })

    it('shows a no-results message naming the query for a genuinely empty text search', async () => {
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)

      instanceOf(wrapper).browseQuery = 'zzzzzz'
      await vi.advanceTimersByTimeAsync(400)
      await flushPromises()

      expect(document.body.textContent).toContain('No stations found for "zzzzzz"')
    })

    it('shows a filter-only no-results message when no query was typed', async () => {
      const wrapper = mountRadioView()
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
      const wrapper = mountRadioView()
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
      const wrapper = mountRadioView()
      await openAndSettle(wrapper)
      instanceOf(wrapper).browseQuery = 'jazz'
      instanceOf(wrapper).browseCountry = 'DE'
      instanceOf(wrapper).browseOrder = 'clickcount'
      await flushPromises()
      expect(document.body.textContent).toContain('Example FM')

      vi.mocked(radioBrowser.searchRadioBrowser).mockClear()
      instanceOf(wrapper).openBrowse()
      await flushPromises()

      expect(instanceOf(wrapper).browseQuery).toBe('')
      expect(instanceOf(wrapper).browseCountry).toBe('DE')
      expect(instanceOf(wrapper).browseOrder).toBe('votes')
      expect(radioBrowser.searchRadioBrowser).toHaveBeenCalledWith({
        name: '',
        countrycodes: ['DE'],
        order: 'votes',
      })
    })
  })
})
