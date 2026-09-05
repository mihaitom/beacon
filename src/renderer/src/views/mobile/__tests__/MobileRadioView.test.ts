import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import MobileRadioView from '../MobileRadioView.vue'
import type { RadioStation } from '@/types/library'

const vuetify = createVuetify({ components, directives })

function makeStation(id: string): RadioStation {
  return {
    id,
    name: `Station ${id}`,
    streamUrl: `https://stream.example/${id}`,
    homePageUrl: 'https://station.example',
  } as RadioStation
}

function mountView() {
  return mount(MobileRadioView, {
    global: {
      plugins: [vuetify, i18n],
      stubs: { CoverArt: true, StickyFilter: true, TileContextMenu: true },
    },
  })
}

describe('MobileRadioView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /** The phone shows the remote's own one-line-per-station list rather than
   * the desktop's grid of bordered tiles — see MobileRadioRow.vue. */
  it('lists stations as rows, not as tiles', async () => {
    const library = useLibraryStore()
    vi.spyOn(library, 'fetchRadioStations').mockResolvedValue()
    library.radioStations = [makeStation('a'), makeStation('b')]
    const wrapper = mountView()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAllComponents({ name: 'MobileRadioRow' })).toHaveLength(2)
    expect(wrapper.findAllComponents({ name: 'RadioStationCard' })).toHaveLength(0)
  })

  /** A page of its own, not the desktop one with pieces switched off. That
   * arrangement had a single component answering to two designs and
   * choosing between them with media queries; every other list screen on
   * the phone is its own view, and this is now too. */
  it('is a page in its own right, not the desktop view in disguise', () => {
    vi.spyOn(useLibraryStore(), 'fetchRadioStations').mockResolvedValue()
    const wrapper = mountView()

    expect(wrapper.findComponent({ name: 'RadioView' }).exists()).toBe(false)
    // No hero header and no "add by hand" either — a stream URL is not
    // something anyone types on a phone.
    expect(wrapper.findComponent({ name: 'DetailHeader' }).exists()).toBe(false)
    expect(wrapper.find('.mdi-plus').exists()).toBe(false)
  })

  /** The station search is the one part of Radio the two pages genuinely
   * share, and the one with a third-party API behind it that should not be
   * wired up twice — but the phone shaping of it still has to be asked
   * for. Forgetting that costs it silently. */
  it('asks the shared search dialog for its phone shaping', () => {
    vi.spyOn(useLibraryStore(), 'fetchRadioStations').mockResolvedValue()
    const wrapper = mountView()

    expect(wrapper.findComponent({ name: 'RadioDiscoverDialog' }).props('compact')).toBe(true)
  })

  /** Turned off here until the discover dialog stopped being a wide desktop
   * table; the entry point lives in the flat header the phone uses. */
  it('offers the discover entry point', async () => {
    const library = useLibraryStore()
    vi.spyOn(library, 'fetchRadioStations').mockResolvedValue()
    library.radioStations = []
    const wrapper = mountView()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.mdi-compass-outline').exists()).toBe(true)
  })
})
