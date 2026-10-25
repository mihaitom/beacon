// Real-browser tests for the stars in the album and artist lists' rows - run
// via `pnpm test:layout`. Both checks are grid columns and a container
// query, which jsdom does not lay out at all.
//
// The stars sit in a fixed column between the figures and the heart: too
// narrow a column and the fifth star runs under the heart. And in a narrow
// list they are a column that gives way, so the name keeps its room (the
// columns the view hands a row for its width, listColumns.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import AlbumCard from '../AlbumCard.vue'
import ArtistCard from '../ArtistCard.vue'
import { DEFAULT_ALBUM_COLUMNS, albumColumnsFor } from '@/services/library/albumColumns'
import { DEFAULT_ARTIST_COLUMNS, artistColumnsFor } from '@/services/library/artistColumns'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

const album = {
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
  rating: 4,
  songs: [],
}

const artist = {
  id: 'ar',
  name: 'The Tide',
  albumCount: 3,
  coverArtId: null,
  imageUrl: null,
  starred: false,
  rating: 4,
  albums: [],
}

/** One row inside a list of the given width, given the columns its view
 * picks for that width. */
async function mountRow(kind: 'album' | 'artist', width: number) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  const list = document.createElement('div')
  list.style.width = `${width}px`
  document.body.appendChild(list)
  const wrapper =
    kind === 'album'
      ? mount(AlbumCard, {
          props: { album, row: true, columns: albumColumnsFor(DEFAULT_ALBUM_COLUMNS, width, true) },
          attachTo: list,
          global: { plugins: [vuetify, i18n, router], stubs: { CoverArt: true } },
        })
      : mount(ArtistCard, {
          props: {
            artist,
            row: true,
            columns: artistColumnsFor(DEFAULT_ARTIST_COLUMNS, width, true),
          },
          attachTo: list,
          global: { plugins: [vuetify, i18n, router], stubs: { CoverArt: true } },
        })
  wrappers.push(wrapper)
  // The list stretches its rows (ArtistsView.vue's .artist-grid--list
  // .artist-card); on its own an artist card keeps its tile width.
  ;(wrapper.element as HTMLElement).style.width = '100%'
  await wrapper.vm.$nextTick()
}

const rect = (selector: string) =>
  (document.querySelector(selector) as HTMLElement).getBoundingClientRect()

describe.each(['album', 'artist'] as const)('the %s row stars', (kind) => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    await page.viewport(1200, 800)
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
  })

  it('fit their column, clear of the heart', async () => {
    await mountRow(kind, 900)
    const stars = [...document.querySelectorAll(`.${kind}-row__rating .v-icon`)].map((icon) =>
      icon.getBoundingClientRect(),
    )

    expect(stars).toHaveLength(5)
    expect(stars[4]!.right).toBeLessThanOrEqual(rect(`.${kind}-row__star`).left)
    // On one line, not wrapped onto a second inside the 56px row.
    expect(new Set(stars.map((star) => Math.round(star.top))).size).toBe(1)
  })

  it('give way in a narrow list, and the name gets their room', async () => {
    await mountRow(kind, 900)
    expect(rect(`.${kind}-row__rating`).width).toBeGreaterThan(0)
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''

    await mountRow(kind, 560)

    const rating = document.querySelector(`.${kind}-row__rating`)
    expect(rating?.getBoundingClientRect().width ?? 0).toBe(0)
    expect(rect(`.${kind}-row__name`).width).toBeGreaterThan(150)
  })
})
