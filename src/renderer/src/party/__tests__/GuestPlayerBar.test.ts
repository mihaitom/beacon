import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import GuestPlayerBar from '../components/GuestPlayerBar.vue'
import PartyGuestApp from '../PartyGuestApp.vue'
import { usePartyGuestStore } from '../store'
import { partyApi, type GuestSnapshot } from '../api'

const SONG = {
  id: 's1',
  title: 'Harbor Lights',
  artist: 'The Tide',
  album: null,
  duration: 200,
  cover: null,
}

function snapshot(listen: boolean): GuestSnapshot {
  return {
    playing: true,
    position: 74,
    duration: 200,
    position_at: Date.now() / 1000,
    casting: false,
    backdrop: false,
    backdrop_index: 0,
    backdrop_count: 0,
    lyrics_key: null,
    current_song: SONG,
    radio: null,
    upcoming: [],
    listen: { enabled: listen, epoch: null, timeline: [] },
    me: { name: 'Anna' },
    limits: { max_pending: 3, pending: 0 },
    skip: { enabled: false, votes: 0, needed: 1, mine: false },
  }
}

function mountBar() {
  const vuetify = createVuetify({ components, directives })
  return mount(GuestPlayerBar, { global: { plugins: [vuetify, i18n] } })
}

describe('the online party player bar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.restoreAllMocks()
    vi.spyOn(partyApi, 'waveform').mockResolvedValue({ peaks: [0.5, 0.2] })
  })

  it('starts and stops this guest’s own stream with the play button', async () => {
    const store = usePartyGuestStore()
    store.applySnapshot(snapshot(true))
    const start = vi.spyOn(store, 'startListening').mockImplementation(() => {
      store.listenState = 'playing'
    })
    const stop = vi.spyOn(store, 'stopListening').mockImplementation(() => {
      store.listenState = 'off'
    })
    const wrapper = mountBar()
    const play = wrapper.find('.guest-player-bar__play')
    await play.trigger('click')
    expect(start).toHaveBeenCalledTimes(1)
    await play.trigger('click')
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('a stream given up on starts again from the same button', async () => {
    const store = usePartyGuestStore()
    store.applySnapshot(snapshot(true))
    store.listenState = 'failed'
    const start = vi.spyOn(store, 'startListening').mockImplementation(() => {})
    const wrapper = mountBar()
    await wrapper.find('.guest-player-bar__play').trigger('click')
    expect(start).toHaveBeenCalled()
  })

  it('loads the waveform of the song shown', async () => {
    const store = usePartyGuestStore()
    store.applySnapshot(snapshot(true))
    mountBar()
    await vi.waitFor(() => expect(store.waveform.peaks).toEqual([0.5, 0.2]))
    expect(partyApi.waveform).toHaveBeenCalledWith('s1')
  })

  it('changes only this browser’s volume, and remembers it', async () => {
    const store = usePartyGuestStore()
    store.applySnapshot(snapshot(true))
    store.volumeAdjustable = true
    const wrapper = mountBar()
    const slider = wrapper.find('input[type="range"]')
    await slider.setValue(40)
    expect(store.volume).toBe(40)
    expect(localStorage.getItem('beacon_party_volume')).toBe('40')
  })

  it('offers no slider where the browser ignores it', () => {
    const store = usePartyGuestStore()
    store.applySnapshot(snapshot(true))
    store.volumeAdjustable = false
    expect(mountBar().find('input[type="range"]').exists()).toBe(false)
  })

  it('is only there while the host offers the online party', async () => {
    const store = usePartyGuestStore()
    vi.spyOn(store, 'start').mockResolvedValue()
    store.phase = 'app'
    store.snapshot = snapshot(false)
    const vuetify = createVuetify({ components, directives })
    const wrapper = mount(PartyGuestApp, { global: { plugins: [vuetify, i18n] } })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.guest-player-bar').exists()).toBe(false)
    store.snapshot = snapshot(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.guest-player-bar').exists()).toBe(true)
  })
})
