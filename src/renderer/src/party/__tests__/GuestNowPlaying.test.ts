import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import GuestNowPlaying from '../components/GuestNowPlaying.vue'
import { usePartyGuestStore } from '../store'
import type { GuestRadio, GuestSnapshot } from '../api'

const vuetify = createVuetify({ components, directives })

function radioSnapshot(radio: GuestRadio): GuestSnapshot {
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

function mountWith(radio: GuestRadio) {
  usePartyGuestStore().snapshot = radioSnapshot(radio)
  return mount(GuestNowPlaying, { global: { plugins: [vuetify, i18n] } })
}

describe('GuestNowPlaying on radio', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it("shows the station's current title with the station under it", () => {
    const wrapper = mountWith({ name: 'Chill FM', now_playing: 'Artist - Track', logo: null })
    expect(wrapper.find('.guest-np__title').text()).toBe('Artist - Track')
    expect(wrapper.text()).toContain('Chill FM')
  })

  it('shows the station name alone while it sends no title', () => {
    const wrapper = mountWith({ name: 'Chill FM', now_playing: null, logo: null })
    expect(wrapper.find('.guest-np__title').text()).toBe('Chill FM')
  })

  it("shows the station's logo as the artwork", () => {
    const logo = '/party/api/radio-logo?k=abc'
    const wrapper = mountWith({ name: 'Chill FM', now_playing: null, logo })
    expect(wrapper.find(`img[src="${logo}"]`).exists()).toBe(true)
  })
})
