import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import PartyGuestApp from '../PartyGuestApp.vue'
import { usePartyGuestStore } from '../store'
import type { GuestSnapshot } from '../api'

const DESKTOP_WIDTH = window.innerWidth

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
    me: { name: 'Anna' },
    limits: { max_pending: 3, pending: 0 },
    skip: { enabled: false, votes: 0, needed: 1, mine: false },
  }
}

async function mountApp(radio: GuestSnapshot['radio'], width = DESKTOP_WIDTH) {
  window.innerWidth = width
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
    window.innerWidth = DESKTOP_WIDTH
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

describe('PartyGuestApp with the shared Now Playing', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => {
    window.innerWidth = DESKTOP_WIDTH
  })

  it('offers the skip vote but none of the host lyrics tools', async () => {
    window.innerWidth = DESKTOP_WIDTH
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
})
