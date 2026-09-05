import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import RadioView from '../RadioView.vue'
import RadioStationCard from '@/components/library/RadioStationCard.vue'
import TileSkeleton from '@/components/library/TileSkeleton.vue'
import * as radioBrowser from '@/services/connect/radioBrowser'
import type { RadioStation } from '@/types/library'

vi.mock('@/services/connect/radioBrowser', () => ({
  searchRadioBrowser: vi.fn(),
  listRadioBrowserCountries: vi.fn(),
  registerRadioBrowserClick: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })

function makeStations(count: number): RadioStation[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    name: `Station ${i}`,
    streamUrl: `https://stream.example/${i}`,
    homePageUrl: null,
  }))
}

function mountRadioView() {
  return mount(RadioView, {
    global: {
      plugins: [vuetify, i18n],
      // StickyFilter.vue uses a real IntersectionObserver, which jsdom
      // doesn't implement — unrelated to what's under test here (see
      // SongsView.test.ts's identical stub/comment).
      stubs: { CoverArt: true, StickyFilter: true },
    },
    // v-dialog teleports its content out of the component tree — without
    // this it's beyond both the wrapper's and document.querySelector's
    // reach (see KeyboardShortcutsDialog.test.ts's identical comment).
    attachTo: document.body,
  })
}

async function withFilterQuery(wrapper: ReturnType<typeof mountRadioView>, query: string) {
  const vm = wrapper.vm as unknown as { debouncedQuery: string }
  vm.debouncedQuery = query
  await wrapper.vm.$nextTick()
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

  describe('saved-station search', () => {
    it('hides the search field for a short list not worth searching', () => {
      useLibraryStore().radioStations = makeStations(3)
      const wrapper = mountRadioView()

      expect(wrapper.findComponent({ name: 'StickyFilter' }).exists()).toBe(false)
    })

    it('offers a search field once there are enough stations to search through', () => {
      useLibraryStore().radioStations = makeStations(9)
      const wrapper = mountRadioView()

      expect(wrapper.findComponent({ name: 'StickyFilter' }).exists()).toBe(true)
    })

    it('filters the grid by name', async () => {
      useLibraryStore().radioStations = makeStations(9)
      const wrapper = mountRadioView()

      expect(wrapper.findAllComponents({ name: 'RadioStationCard' })).toHaveLength(9)

      await withFilterQuery(wrapper, 'Station 3')

      const cards = wrapper.findAllComponents({ name: 'RadioStationCard' })
      expect(cards).toHaveLength(1)
      expect(cards[0]!.props('station').name).toBe('Station 3')
    })

    it('tells "nothing saved yet" apart from "nothing matches this search"', async () => {
      const noneYet = mountRadioView()
      expect(noneYet.text()).toContain('No radio stations saved yet')

      useLibraryStore().radioStations = makeStations(9)
      const wrapper = mountRadioView()
      await withFilterQuery(wrapper, 'nothing matches this')

      expect(wrapper.text()).toContain('No stations for "nothing matches this"')
      expect(wrapper.text()).not.toContain('No radio stations saved yet')
    })
  })

  describe('while the station list is still loading', () => {
    it('holds the layout still with tile-shaped placeholders instead of a spinner', async () => {
      const library = useLibraryStore()
      library.loadingCount = 1
      const wrapper = mountRadioView()
      await wrapper.vm.$nextTick()

      expect(wrapper.findAllComponents(TileSkeleton).length).toBeGreaterThan(0)
      // A spinner in the flow was what pushed everything below it down
      // while it was there, and back up when it went.
      expect(wrapper.findComponent({ name: 'VProgressCircular' }).exists()).toBe(false)
      // Not the "no stations yet" alert either — nothing is known yet.
      expect(wrapper.text()).not.toContain(i18n.global.t('radio.noStationsYet'))
    })

    it('leaves a list that is already on screen alone while something else loads', async () => {
      // `loading` is the whole library store's, so a tile menu fetching an
      // album's tracks sets it too — swapping the stations for placeholders
      // then would be a worse jump than the one this replaced.
      const library = useLibraryStore()
      library.radioStations = makeStations(3)
      library.loadingCount = 1
      const wrapper = mountRadioView()
      await wrapper.vm.$nextTick()

      expect(wrapper.findAllComponents(TileSkeleton)).toHaveLength(0)
      expect(wrapper.findAllComponents(RadioStationCard)).toHaveLength(3)
    })
  })
})
