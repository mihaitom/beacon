// Real-browser test for the cursor over artwork that opens full size — run
// via `pnpm test:layout`. It is a scoped CSS property, which jsdom neither
// applies nor computes, so a jsdom version would pass whatever the rule
// says, including the plain `cursor: pointer` the artist shelf shipped with
// at first.
//
// Why it is worth pinning at all: the magnifier is what tells these two
// apart from everything else that is clickable. A pointer reads as "this
// goes somewhere", and a suggested-artist card deliberately goes nowhere —
// it has no page in this app to go to. Both places that open the viewer
// have to agree, and nothing but a test makes them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import DetailHeader from '../DetailHeader.vue'
import SimilarArtistsShelf, { type SimilarArtistDisplay } from '../SimilarArtistsShelf.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

const mountOptions = {
  attachTo: document.body,
  global: {
    plugins: [vuetify, i18n],
    stubs: { RouterLink: true },
    mocks: { $router: { push: () => {} } },
  },
}

function track<T extends VueWrapper>(wrapper: T): T {
  wrappers.push(wrapper)
  return wrapper
}

function cursorOf(wrapper: VueWrapper, selector: string): string {
  return getComputedStyle(wrapper.get(selector).element).cursor
}

describe('artwork that opens full size', () => {
  beforeEach(() => {
    // DetailHeader reads the auth store for its backdrop URL.
    setActivePinia(createPinia())
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('shows a magnifier on a detail header cover', () => {
    const wrapper = track(
      mount(DetailHeader, {
        ...mountOptions,
        props: { title: 'Slow Return', coverArtId: 'cover-1', zoomable: true },
      }),
    )

    expect(cursorOf(wrapper, '.detail-header__cover--zoomable')).toBe('zoom-in')
  })

  it('shows the same magnifier on a suggested artist card', () => {
    const artist = {
      mbid: 'mb-1',
      name: 'The Tide',
      imageUrl: 'https://art/tide.jpg',
      largeImageUrl: 'https://art/tide-xl.jpg',
      links: { musicbrainz: 'https://musicbrainz.org/artist/mb-1' },
    } as SimilarArtistDisplay

    const wrapper = track(
      mount(SimilarArtistsShelf, {
        ...mountOptions,
        props: { title: 'New artists to explore', artists: [artist], loading: false },
      }),
    )

    expect(cursorOf(wrapper, '.similar-artists-card-art-button')).toBe('zoom-in')
  })
})
