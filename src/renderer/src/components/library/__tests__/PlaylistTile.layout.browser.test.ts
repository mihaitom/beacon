// Real-browser test for PlaylistTile.vue's cover play-overlay — run via
// `pnpm test:layout`. What's checked (Vuetify's own icon-button sizing
// overridden via CSS, opacity-on-hover) is scoped CSS jsdom neither
// applies nor lays out, so a jsdom version would pass however (or
// wherever) the button actually rendered — including, notably, Vuetify's
// default circular icon-button box winning over the override and the
// button sitting mis-sized in a corner of the cover instead of filling it.
import { afterEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { i18n } from '@/i18n'
import PlaylistTile from '../PlaylistTile.vue'
import type { Playlist } from '@/types/library'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

function makePlaylist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: 'p1',
    name: 'My mix',
    songCount: 10,
    duration: 1800,
    coverArtId: null,
    public: false,
    owner: 'thomas',
    songs: [],
    ...overrides,
  }
}

function mountTile() {
  const wrapper = mount(PlaylistTile, {
    props: { playlist: makePlaylist() },
    attachTo: document.body,
    global: { plugins: [vuetify, i18n] },
  })
  wrappers.push(wrapper)
  return wrapper
}

describe('PlaylistTile cover play-overlay layout', () => {
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
  })

  it('exactly fills the cover art, not a smaller circle floating in a corner of it', async () => {
    await page.viewport(1200, 800)
    mountTile()

    const cover = document.querySelector('.playlist-tile__cover-wrap')!.getBoundingClientRect()
    const overlay = document.querySelector('.playlist-tile__play-overlay')!.getBoundingClientRect()

    expect(overlay.width).toBeCloseTo(cover.width, 0)
    expect(overlay.height).toBeCloseTo(cover.height, 0)
    expect(overlay.top).toBeCloseTo(cover.top, 0)
    expect(overlay.left).toBeCloseTo(cover.left, 0)
  })

  it('is invisible until the tile is hovered', async () => {
    await page.viewport(1200, 800)
    mountTile()

    const overlay = document.querySelector('.playlist-tile__play-overlay') as HTMLElement
    expect(getComputedStyle(overlay).opacity).toBe('0')

    await userEvent.hover(document.querySelector('.playlist-tile')!)
    // The 0.15s opacity transition is a running animation while mid-flight
    // — read after it settles rather than immediately on hover() resolving.
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(getComputedStyle(overlay).opacity).toBe('1')
  })
})
