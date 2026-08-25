// The shelf/chevron mechanics (paging, wrap mode) are CardShelf.vue's own
// responsibility and tested there — this file only covers what's specific
// to *this* shelf: the artist card markup and its external-service links.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import SimilarArtistsShelf, { type SimilarArtistDisplay } from '../SimilarArtistsShelf.vue'

const vuetify = createVuetify({ components, directives })

function makeArtist(overrides: Partial<SimilarArtistDisplay> = {}): SimilarArtistDisplay {
  return {
    mbid: 'mb-1',
    name: 'The Tide',
    imageUrl: 'https://art/tide.jpg',
    // HomeView's lookup always leaves at least a musicbrainz entry — see
    // SimilarArtistDisplay's own docstring.
    links: { musicbrainz: 'https://musicbrainz.org/artist/mb-1' },
    ...overrides,
  } as SimilarArtistDisplay
}

function mountShelf(artists: SimilarArtistDisplay[] = [makeArtist()]) {
  return mount(SimilarArtistsShelf, {
    props: { title: 'New artists to explore', artists },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
  })
}

describe('SimilarArtistsShelf', () => {
  it('renders one card per artist under its own heading', () => {
    const wrapper = mountShelf([
      makeArtist({ mbid: 'mb-1', name: 'The Tide' }),
      makeArtist({ mbid: 'mb-2', name: 'Harbor Lights' }),
    ])

    expect(wrapper.get('.section-title').text()).toBe('New artists to explore')
    const cards = wrapper.findAll('.similar-artists-card')
    expect(cards).toHaveLength(2)
    expect(cards[1]!.text()).toContain('Harbor Lights')
  })

  it('hides itself entirely when the lookup came back with nobody', () => {
    // Its host renders it unconditionally, so this is what keeps an empty
    // heading off the Home view.
    const wrapper = mountShelf([])

    expect(wrapper.findComponent({ name: 'CardShelf' }).exists()).toBe(false)
  })

  it('links out to every service the lookup found, rather than picking one', () => {
    const wrapper = mountShelf([
      makeArtist({
        links: {
          deezer: 'https://deezer.com/artist/1',
          musicbrainz: 'https://musicbrainz.org/artist/mb-1',
        },
      }),
    ])

    const links = wrapper.findAll('.similar-artists-card-link')
    expect(links).toHaveLength(2)
    expect(links.map((link) => link.attributes('href'))).toEqual([
      'https://deezer.com/artist/1',
      'https://musicbrainz.org/artist/mb-1',
    ])
    // Opened outside the app, never in place.
    expect(links.every((link) => link.attributes('target') === '_blank')).toBe(true)
    expect(links.every((link) => link.attributes('rel') === 'noopener')).toBe(true)
  })

  it('is the icons that link, not the card itself', () => {
    // Unlike an owned artist's card, there is no in-app page to navigate
    // to — the card deliberately isn't a link.
    const wrapper = mountShelf()

    expect(wrapper.get('.similar-artists-card').element.tagName).toBe('DIV')
    expect(wrapper.get('.similar-artists-card').find('a.similar-artists-card-name').exists()).toBe(
      false,
    )
  })

  it('is passed through to CardShelf as its title', () => {
    const wrapper = mountShelf()

    expect(wrapper.getComponent({ name: 'CardShelf' }).props('title')).toBe(
      'New artists to explore',
    )
  })
})
