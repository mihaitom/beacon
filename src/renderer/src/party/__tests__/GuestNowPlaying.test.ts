import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { extractDominantColor } from '@/services/colorExtractor'
import GuestNowPlaying from '../components/GuestNowPlaying.vue'
import { usePartyGuestStore } from '../store'
import type { GuestRadio, GuestSnapshot, GuestSong } from '../api'

vi.mock('@/services/colorExtractor', () => ({ extractDominantColor: vi.fn() }))

const vuetify = createVuetify({ components, directives })
const AMBER = '245, 169, 78'
const LOGO = '/party/api/radio-logo?k=abc'

function snapshot(song: GuestSong | null, radio: GuestRadio | null): GuestSnapshot {
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
    current_song: song,
    radio,
    upcoming: [],
    me: { name: 'Anna' },
    limits: { max_pending: 3, pending: 0 },
    skip: { enabled: false, votes: 0, needed: 1, mine: false },
  }
}

async function mountWith(song: GuestSong | null, radio: GuestRadio | null = null) {
  usePartyGuestStore().snapshot = snapshot(song, radio)
  const wrapper = mount(GuestNowPlaying, { global: { plugins: [vuetify, i18n] } })
  await flushPromises()
  return wrapper
}

/** connect's answer for the logo, with its transparency reading. */
function serveLogo(transparent: boolean) {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response('', { headers: { 'X-Has-Transparency': String(transparent) } }),
      ),
  )
}

const SONG: GuestSong = {
  id: 's1',
  title: 'Harbor Lights',
  artist: 'The Tide',
  album: 'Low Water',
  duration: 200,
  cover: '/party/api/cover?id=c1',
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.mocked(extractDominantColor).mockReset().mockResolvedValue([0, 0, 0])
  serveLogo(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GuestNowPlaying with a song', () => {
  it('shows the album as the app does', async () => {
    const wrapper = await mountWith(SONG)
    expect(wrapper.text()).toContain('Low Water')
  })

  it("takes its glow from the song's cover", async () => {
    const wrapper = await mountWith(SONG)
    expect(wrapper.find('.guest-np__art-glow').attributes('style')).toContain('0, 0, 0')
  })
})

describe('GuestNowPlaying on radio', () => {
  it("shows the station's current title with the station under it", async () => {
    const wrapper = await mountWith(null, {
      name: 'Chill FM',
      now_playing: 'Artist - Track',
      logo: null,
    })
    expect(wrapper.find('.guest-np__title').text()).toBe('Artist - Track')
    expect(wrapper.text()).toContain('Chill FM')
  })

  it('shows the station name alone while it sends no title', async () => {
    const wrapper = await mountWith(null, { name: 'Chill FM', now_playing: null, logo: null })
    expect(wrapper.find('.guest-np__title').text()).toBe('Chill FM')
  })

  it("shows the station's logo as the artwork", async () => {
    const wrapper = await mountWith(null, { name: 'Chill FM', now_playing: null, logo: LOGO })
    expect(wrapper.find(`img[src="${LOGO}"]`).exists()).toBe(true)
  })

  it('keeps the amber glow, so a dark logo stays readable', async () => {
    const wrapper = await mountWith(null, { name: 'Chill FM', now_playing: null, logo: LOGO })
    expect(wrapper.find('.guest-np__art-glow').attributes('style')).toContain(AMBER)
  })

  it('puts no card around a logo that floats on transparency', async () => {
    serveLogo(true)
    const wrapper = await mountWith(null, { name: 'Chill FM', now_playing: null, logo: LOGO })
    expect(wrapper.find(`img[src="${LOGO}"]`).classes()).not.toContain('cover-shadow')
  })

  it('keeps the card for an opaque logo', async () => {
    const wrapper = await mountWith(null, { name: 'Chill FM', now_playing: null, logo: LOGO })
    expect(wrapper.find(`img[src="${LOGO}"]`).classes()).toContain('cover-shadow')
  })
})
