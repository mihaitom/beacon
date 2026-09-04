// Real-browser tests for the album and artist cards — run via
// `pnpm test:layout`. Both things checked here are scoped CSS (a heart's
// colour, the cards' own footprint), and jsdom applies neither, so a jsdom
// version would pass no matter how either rendered.
//
// Card size: the two card types sit side by side (search results, the
// favorites view, anywhere both kinds are listed), and an artist card used
// to be 200px wide against an album card's 160px.
//
// Heart: the rule under test is scoped CSS with
// !important overrides fighting Vuetify's own button painting, and jsdom
// applies neither, so a jsdom version would pass no matter which way the
// heart rendered.
//
// The bug it pins (reported live 2026-08-25): an artist card's heart stayed
// dark when the artist was favourited, unlike everywhere else in the app
// where amber means "this is on". The card's own resting style paints a
// dark pill behind the icon so an *unstarred* heart stays legible over
// artwork — and since Vuetify paints `color` onto the background of a flat
// button, that override swallowed the amber entirely. AlbumCard.vue already
// carried the fix; ArtistCard.vue never got it.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import AlbumCard from '../AlbumCard.vue'
import ArtistCard from '../ArtistCard.vue'
import AlbumShelf from '../AlbumShelf.vue'
import type { Album } from '@/types/library'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/albums/:id', component: { template: '<div />' } },
      { path: '/artists/:id', component: { template: '<div />' } },
    ],
  })
}

async function mountCard(kind: 'album' | 'artist', starred: boolean) {
  const router = makeRouter()
  await router.push('/')
  await router.isReady()
  const wrapper =
    kind === 'album'
      ? mount(AlbumCard, {
          props: {
            album: {
              id: 'a',
              name: 'Slow Return',
              artist: 'The Tide',
              artistId: 'ar',
              coverArtId: null,
              year: 2024,
              songCount: 10,
              duration: 2400,
              genre: null,
              starred,
              rating: 0,
              songs: [],
            },
          },
          attachTo: document.body,
          global: { plugins: [vuetify, i18n, router], stubs: { CoverArt: true } },
        })
      : mount(ArtistCard, {
          props: {
            artist: {
              id: 'ar',
              name: 'The Tide',
              albumCount: 3,
              coverArtId: null,
              imageUrl: null,
              starred,
              rating: 0,
              albums: [],
            },
          },
          attachTo: document.body,
          global: { plugins: [vuetify, i18n, router], stubs: { CoverArt: true } },
        })
  wrappers.push(wrapper)
  // The heart only renders where the server supports favourites at all.
  useAuthStore().capabilities.favorites = true
  await wrapper.vm.$nextTick()
  return wrapper
}

/** The heart's own rendered colours — the icon's color, and whatever the
 * button paints behind it. */
function heartStyle(kind: 'album' | 'artist') {
  const button = document.querySelector(`.${kind}-card-star`) as HTMLElement
  const overlay = button.querySelector('.v-btn__overlay') as HTMLElement | null
  return {
    color: getComputedStyle(button).color,
    background: getComputedStyle(button).backgroundColor,
    overlayOpacity: overlay ? getComputedStyle(overlay).opacity : '0',
  }
}

describe('card footprint', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('is identical for album and artist cards', async () => {
    await page.viewport(1200, 800)
    await mountCard('album', false)
    const album = (document.querySelector('.album-card') as HTMLElement).getBoundingClientRect()

    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    await mountCard('artist', false)
    const artist = (document.querySelector('.artist-card') as HTMLElement).getBoundingClientRect()

    expect(artist.width).toBe(album.width)
    // Height follows from the width here — both are a square cover plus a
    // name line and a caption line — but it's the half that actually shows
    // in a mixed grid, so it's worth stating rather than implying.
    expect(Math.round(artist.height)).toBe(Math.round(album.height))
  })
})

describe('shelf placeholders', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  async function mountShelf(loading: boolean) {
    const router = makeRouter()
    await router.push('/')
    await router.isReady()
    const album: Album = {
      id: 'a',
      name: 'Slow Return',
      artist: 'The Tide',
      artistId: 'ar',
      coverArtId: null,
      year: 2024,
      songCount: 10,
      duration: 2400,
      genre: null,
      starred: false,
      rating: 0,
      songs: [],
    }
    const wrapper = mount(AlbumShelf, {
      // CoverArt is deliberately *not* stubbed here, unlike everywhere else
      // in this file: the height being compared is mostly the cover's, and
      // a stub has none. An album with no coverArtId renders its fallback
      // icon at the size it was given without fetching anything.
      props: { title: 'Recently played', albums: loading ? [] : [album], loading },
      attachTo: document.body,
      global: { plugins: [vuetify, i18n, router] },
    })
    wrappers.push(wrapper)
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('is exactly the size of the card it stands in for', async () => {
    // The whole point of a placeholder shaped like the content: nothing
    // below the shelf may move when the real cards arrive. It got this
    // wrong by 4px per card, because the skeleton drew the artist line at
    // the title's 20px instead of its own 16px (text-body-small).
    await page.viewport(1200, 800)
    await mountShelf(true)
    const placeholder = (
      document.querySelector('.album-shelf-skeleton-item') as HTMLElement
    ).getBoundingClientRect()

    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    await mountShelf(false)
    const card = (document.querySelector('.album-card') as HTMLElement).getBoundingClientRect()

    expect(Math.round(placeholder.width)).toBe(Math.round(card.width))
    expect(Math.round(placeholder.height)).toBe(Math.round(card.height))
  })

  it('fills the row it is in rather than a fixed number of them', async () => {
    // 1200px of viewport, minus the container's own padding, holds six
    // 160px cards with their 20px gaps — the placeholders follow the
    // window instead of stopping at a hardcoded count.
    await page.viewport(1200, 800)
    await mountShelf(true)

    expect(document.querySelectorAll('.album-shelf-skeleton-item').length).toBeGreaterThan(6)
  })
})

describe.each(['album', 'artist'] as const)('%s card favourite heart', (kind) => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('is amber on nothing once favourited', async () => {
    await page.viewport(1200, 800)
    await mountCard(kind, false)
    const unstarred = heartStyle(kind)

    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    await mountCard(kind, true)
    const starred = heartStyle(kind)

    // The specific amber comes from the theme; what matters here is that
    // favouriting actually changes the heart's colour at all...
    expect(starred.color).not.toBe(unstarred.color)
    // ...and that the dark pill behind it is gone, which is what used to
    // swallow the colour on an artist card.
    expect(starred.background).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
    expect(unstarred.background).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  })
})
