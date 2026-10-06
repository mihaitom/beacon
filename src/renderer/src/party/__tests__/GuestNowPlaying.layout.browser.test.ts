// Real-browser layout test for the party guest page's lyrics - run via
// `pnpm test:layout`. Whether a scroll area actually scrolls depends on the
// flex chain giving it a bounded height, which jsdom does not compute.
//
// The bug it pins: the guest page's lyrics wrapper was a plain block, so
// LyricsLines' scroll area (flex: 1, min-height: 0) grew to the whole text
// and was clipped instead of scrolling - unsynced lyrics past the first
// screen could not be read at all.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { i18n } from '@/i18n'
import GuestNowPlaying from '../components/GuestNowPlaying.vue'
import { usePartyGuestStore } from '../store'
import type { GuestSnapshot } from '../api'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

function snapshot(): GuestSnapshot {
  return {
    playing: true,
    position: 0,
    duration: 200,
    position_at: Date.now() / 1000,
    casting: false,
    backdrop: false,
    backdrop_index: 0,
    backdrop_count: 0,
    lyrics_key: null,
    current_song: {
      id: 'a',
      title: 'Harbor Lights',
      artist: 'The Tide',
      album: null,
      duration: 200,
      cover: null,
    },
    radio: null,
    upcoming: [],
    me: { name: 'Anna' },
    limits: { max_pending: 3, pending: 0 },
    skip: { enabled: false, votes: 0, needed: 1, mine: false },
  }
}

async function mountStage(compact: boolean, synced: boolean) {
  const host = document.createElement('div')
  host.style.height = compact ? '640px' : '800px'
  host.style.width = compact ? '390px' : '1000px'
  document.body.appendChild(host)
  const store = usePartyGuestStore()
  store.snapshot = snapshot()
  store.lyrics = {
    song_id: 'a',
    synced,
    offset: 0,
    lines: Array.from({ length: 80 }, (_, i) => ({ time: i * 3, text: `Line ${i + 1}` })),
  }
  const wrapper = mount(GuestNowPlaying, {
    attachTo: host,
    props: { compact },
    global: { plugins: [vuetify, i18n] },
  })
  wrappers.push(wrapper)
  await wrapper.vm.$nextTick()
  await new Promise((resolve) => setTimeout(resolve, 150))
  return document.querySelector('.guest-np__lyrics .lyrics-panel__scroll') as HTMLElement
}

describe('party guest lyrics', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    await page.viewport(1200, 900)
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
  })

  for (const compact of [false, true]) {
    for (const synced of [false, true]) {
      it(`scroll inside their panel (${compact ? 'phone' : 'desktop'}, ${synced ? 'synced' : 'unsynced'})`, async () => {
        const scroll = await mountStage(compact, synced)
        const panel = scroll.parentElement!
        expect(scroll.scrollHeight, 'too few lines to need scrolling').toBeGreaterThan(
          scroll.clientHeight,
        )
        // Bounded by the panel, not grown to the text and clipped by it.
        expect(scroll.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          panel.getBoundingClientRect().bottom + 0.5,
        )
        scroll.scrollTop = 0
        scroll.scrollTop = 400
        expect(scroll.scrollTop).toBeGreaterThan(0)
      })
    }
  }
})
