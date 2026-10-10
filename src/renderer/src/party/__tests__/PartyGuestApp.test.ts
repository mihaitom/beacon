import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import PartyGuestApp from '../PartyGuestApp.vue'
import { usePartyGuestStore } from '../store'
import { PartyApiError } from '../api'
import { GITHUB_URL } from '@/services/project'
import type { GuestSnapshot } from '../api'
import { PHONE_LANDSCAPE_QUERY } from '@/composables/phoneLandscape'

const DESKTOP_WIDTH = window.innerWidth
const realMatchMedia = window.matchMedia

/** The phone/desktop choice reads the width through a media query (see
 * useIsMobileWeb.ts), which jsdom's stub never matches - answered from the
 * given width here, and the phone's orientation from `sideways`. */
function setWidth(width: number, sideways = false) {
  window.innerWidth = width
  window.matchMedia = ((query: string) => ({
    matches:
      query === PHONE_LANDSCAPE_QUERY
        ? sideways
        : Number(/max-width: ([\d.]+)px/.exec(query)?.[1] ?? -1) >= width,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function resetWidth() {
  window.innerWidth = DESKTOP_WIDTH
  window.matchMedia = realMatchMedia
}

function snapshot(radio: GuestSnapshot['radio']): GuestSnapshot {
  return {
    playing: true,
    position: 0,
    duration: 0,
    position_at: Date.now() / 1000,
    casting: false,
    backdrop: false,
    backdrop_index: 0,
    backdrop_count: 0,
    lyrics_key: null,
    current_song: null,
    radio,
    upcoming: [],
    listen: { enabled: false, epoch: null, timeline: [] },
    me: { name: 'Anna' },
    limits: { max_pending: 3, pending: 0 },
    skip: { enabled: false, votes: 0, needed: 1, mine: false },
  }
}

async function mountApp(radio: GuestSnapshot['radio'], width = DESKTOP_WIDTH) {
  setWidth(width)
  const store = usePartyGuestStore()
  vi.spyOn(store, 'start').mockResolvedValue()
  store.phase = 'app'
  store.snapshot = snapshot(radio)
  const vuetify = createVuetify({ components, directives })
  const wrapper = mount(PartyGuestApp, { global: { plugins: [vuetify, i18n] } })
  await wrapper.vm.$nextTick()
  return wrapper
}

const STATION = { name: 'Chill FM', now_playing: null, logo: null }

describe('PartyGuestApp while a radio station plays', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => {
    resetWidth()
  })

  it('explains instead of offering what is next and the search', async () => {
    const wrapper = await mountApp(STATION)
    expect(wrapper.text()).toContain(i18n.global.t('partyGuest.radioText'))
    expect(wrapper.find('.guest-queue').exists()).toBe(false)
  })

  it('offers them again for music from the library', async () => {
    const wrapper = await mountApp(null)
    expect(wrapper.text()).not.toContain(i18n.global.t('partyGuest.radioText'))
    expect(wrapper.find('.guest-queue').exists()).toBe(true)
  })

  it('explains on a phone too, behind the tabs', async () => {
    const wrapper = await mountApp(STATION, 390)
    const wishTab = wrapper.findAll('.guest-app__tabs .v-btn').at(2)!
    await wishTab.trigger('click')
    expect(wrapper.text()).toContain(i18n.global.t('partyGuest.radioText'))
  })
})

describe('PartyGuestApp joining', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('says a name already in use is taken', async () => {
    const store = usePartyGuestStore()
    vi.spyOn(store, 'start').mockResolvedValue()
    store.phase = 'join'
    vi.spyOn(store, 'join').mockRejectedValue(new PartyApiError(409, 'taken'))
    const vuetify = createVuetify({ components, directives })
    const wrapper = mount(PartyGuestApp, { global: { plugins: [vuetify, i18n] } })
    const vm = wrapper.vm as unknown as { name: string; joinError: string; join(): Promise<void> }
    vm.name = 'Anna'

    await vm.join()

    expect(vm.joinError).toBe(i18n.global.t('partyGuest.nameTaken'))
  })
})

describe('PartyGuestApp with the shared Now Playing', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => {
    resetWidth()
  })

  it('offers the skip vote but none of the host lyrics tools', async () => {
    setWidth(DESKTOP_WIDTH)
    const store = usePartyGuestStore()
    vi.spyOn(store, 'start').mockResolvedValue()
    store.phase = 'app'
    store.snapshot = {
      ...snapshot(null),
      current_song: {
        id: 's1',
        title: 'Harbor Lights',
        artist: 'The Tide',
        album: 'Low Water',
        duration: 200,
        cover: null,
      },
      skip: { enabled: true, votes: 1, needed: 2, mine: false },
    }
    const vuetify = createVuetify({ components, directives })
    const wrapper = mount(PartyGuestApp, { global: { plugins: [vuetify, i18n] } })
    await wrapper.vm.$nextTick()

    // The guest's own control sits in the toolbar.
    expect(wrapper.find('.guest-skip').exists()).toBe(true)
    // Lyrics are showing (the default preference), but read-only.
    expect(wrapper.find('.lyrics-panel').exists()).toBe(true)
    expect(wrapper.find('.lyrics-panel__toolbar').exists()).toBe(false)
  })

  it("closes the visualizer feed on a phone's other tabs", async () => {
    const opened: Array<{ readyState: number }> = []
    vi.stubGlobal(
      'EventSource',
      class {
        readyState = 1
        constructor() {
          opened.push(this)
        }
        close() {
          this.readyState = 2
        }
      },
    )
    setWidth(390)
    const store = usePartyGuestStore()
    vi.spyOn(store, 'start').mockResolvedValue()
    store.phase = 'app'
    store.snapshot = {
      ...snapshot(null),
      casting: true,
      current_song: {
        id: 's1',
        title: 'Harbor Lights',
        artist: 'The Tide',
        album: null,
        duration: 200,
        cover: null,
      },
    }
    const vuetify = createVuetify({ components, directives })
    const wrapper = mount(PartyGuestApp, { global: { plugins: [vuetify, i18n] } })
    await wrapper.vm.$nextTick()
    expect(opened.map((source) => source.readyState)).toEqual([1])

    await wrapper.findAll('.guest-app__tabs .v-btn').at(1)!.trigger('click')

    expect(opened.map((source) => source.readyState)).toEqual([2])
    vi.unstubAllGlobals()
  })

  it('opens no visualizer feed on a phone held sideways, which shows no bars', async () => {
    const opened: unknown[] = []
    vi.stubGlobal(
      'EventSource',
      class {
        readyState = 1
        constructor() {
          opened.push(this)
        }
        close() {
          this.readyState = 2
        }
      },
    )
    setWidth(844, true)
    const store = usePartyGuestStore()
    vi.spyOn(store, 'start').mockResolvedValue()
    store.phase = 'app'
    store.snapshot = {
      ...snapshot(null),
      casting: true,
      current_song: {
        id: 's1',
        title: 'Harbor Lights',
        artist: 'The Tide',
        album: null,
        duration: 200,
        cover: null,
      },
    }
    const vuetify = createVuetify({ components, directives })
    const wrapper = mount(PartyGuestApp, { global: { plugins: [vuetify, i18n] } })
    await wrapper.vm.$nextTick()

    expect(opened).toEqual([])
    vi.unstubAllGlobals()
  })
})

describe('PartyGuestApp with no party to show', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('still says where Beacon comes from', async () => {
    const store = usePartyGuestStore()
    vi.spyOn(store, 'start').mockResolvedValue()
    store.phase = 'message'
    store.message = 'ended'
    const vuetify = createVuetify({ components, directives })
    const wrapper = mount(PartyGuestApp, { global: { plugins: [vuetify, i18n] } })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain(i18n.global.t('partyGuest.endedTitle'))
    expect(wrapper.find(`a[href="${GITHUB_URL}"]`).exists()).toBe(true)
  })
})
