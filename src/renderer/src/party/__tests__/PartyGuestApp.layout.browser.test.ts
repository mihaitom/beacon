// Real-browser layout test for the party guest's phone shell — run via
// `pnpm test:layout`. Whether the shared Now Playing toolbar lands in the
// header's actions slot is a DOM/timing question jsdom answers wrong:
// Vuetify's display breakpoint and Teleport both need a real viewport, so a
// jsdom version passed "false" here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { i18n } from '@/i18n'
import PartyGuestApp from '../PartyGuestApp.vue'
import { usePartyGuestStore } from '../store'
import type { GuestSnapshot } from '../api'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

function songSnapshot(): GuestSnapshot {
  return {
    playing: true,
    position: 10,
    duration: 200,
    position_at: Date.now() / 1000,
    casting: false,
    backdrop: false,
    backdrop_index: 0,
    backdrop_count: 0,
    lyrics_key: null,
    current_song: {
      id: 's1',
      title: 'Harbor Lights',
      artist: 'The Tide',
      album: 'Low Water',
      duration: 200,
      cover: null,
    },
    radio: null,
    upcoming: [],
    listen: { enabled: false, epoch: null, timeline: [] },
    me: { name: 'Anna' },
    limits: { max_pending: 3, pending: 0 },
    skip: { enabled: true, votes: 0, needed: 2, mine: false },
  }
}

describe('PartyGuestApp phone shell', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => {
    wrappers.forEach((wrapper) => wrapper.unmount())
    wrappers.length = 0
  })

  it('docks the Now Playing toolbar into the header, not over the artwork', async () => {
    await page.viewport(390, 844)
    const store = usePartyGuestStore()
    vi.spyOn(store, 'start').mockResolvedValue()
    store.phase = 'app'
    store.snapshot = songSnapshot()

    const wrapper = mount(PartyGuestApp, {
      attachTo: document.body,
      global: { plugins: [vuetify, i18n] },
    })
    wrappers.push(wrapper)
    await new Promise((resolve) => setTimeout(resolve, 80))

    const actions = document.getElementById('mobile-app-bar-actions')
    expect(actions?.querySelector('.now-playing__toolbar')).not.toBeNull()
    // And the toolbar's own buttons, including the guest's skip vote.
    expect(actions?.querySelector('.guest-skip')).not.toBeNull()
  })
})
