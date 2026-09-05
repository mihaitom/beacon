// The shelf/chevron mechanics (paging, wrap mode) are CardShelf.vue's own
// responsibility and tested there — this file only covers what's specific
// to *this* shelf: the artist card markup and its external-service links.
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import type { ArtworkView } from '@/types/events'
import SimilarArtistsShelf, { type SimilarArtistDisplay } from '../SimilarArtistsShelf.vue'

const vuetify = createVuetify({ components, directives })

function makeArtist(overrides: Partial<SimilarArtistDisplay> = {}): SimilarArtistDisplay {
  return {
    mbid: 'mb-1',
    name: 'The Tide',
    imageUrl: 'https://art/tide.jpg',
    largeImageUrl: 'https://art/tide-xl.jpg',
    // HomeView's lookup always leaves at least a musicbrainz entry — see
    // SimilarArtistDisplay's own docstring.
    links: { musicbrainz: 'https://musicbrainz.org/artist/mb-1' },
    ...overrides,
  } as SimilarArtistDisplay
}

function mountShelf(artists: SimilarArtistDisplay[] = [makeArtist()], loading = false) {
  return mount(SimilarArtistsShelf, {
    props: { title: 'New artists to explore', artists, loading },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
  })
}

/** Everything the artwork viewer was asked to show while `run` ran. */
function shown(run: () => void): ArtworkView[] {
  const views: ArtworkView[] = []
  const listener = (view: ArtworkView): void => {
    views.push(view)
  }
  emitter.on('showArtwork', listener)
  run()
  emitter.off('showArtwork', listener)
  return views
}

describe('SimilarArtistsShelf', () => {
  describe('opening the photo full size', () => {
    it('shows the artist photo when the card art is clicked', () => {
      // These cards are the one place in the app with artwork and no other
      // left-click meaning of their own — the card is deliberately not a
      // link, since an artist nobody owns has no page here to go to.
      const wrapper = mountShelf([makeArtist({ name: 'The Tide' })])

      const views = shown(() => {
        void wrapper.get('.similar-artists-card-art-button').trigger('click')
      })

      expect(views).toHaveLength(1)
      expect(views[0]).toMatchObject({
        // The big one: the viewer fills most of the window, where the
        // card's own 250px looked like 250px blown up.
        imageUrl: 'https://art/tide-xl.jpg',
        // And the card's own picture underneath it, so the viewer is
        // filled the instant it opens rather than showing a skeleton over
        // an image the person was already looking at.
        placeholderImageUrl: 'https://art/tide.jpg',
        title: 'The Tide',
        // Same shape the card itself draws it in, so it does not change on
        // the way into the viewer.
        rounded: true,
      })
      // Nothing to resolve through the cover-art batch: this artist is not
      // in the library, which is the point of the shelf.
      expect(views[0]!.coverArtId).toBeUndefined()
    })

    it('falls back to the card photo when the lookup found only one size', () => {
      const wrapper = mountShelf([makeArtist({ largeImageUrl: null })])

      const views = shown(() => {
        void wrapper.get('.similar-artists-card-art-button').trigger('click')
      })

      expect(views[0]).toMatchObject({
        imageUrl: 'https://art/tide.jpg',
        placeholderImageUrl: 'https://art/tide.jpg',
      })
    })

    it('offers no click for an artist with no photo at all', () => {
      // There would be nothing to open but the fallback icon.
      const wrapper = mountShelf([makeArtist({ imageUrl: null })])

      expect(wrapper.find('.similar-artists-card-art-button').exists()).toBe(false)
      expect(wrapper.find('.similar-artists-card-art').exists()).toBe(true)
    })

    it('leaves the service links alone', () => {
      // The icon row below the name has its own destinations — the artwork
      // click must not swallow those.
      const wrapper = mountShelf([makeArtist()])

      const views = shown(() => {
        void wrapper.get('.similar-artists-card-link').trigger('click')
      })

      expect(views).toEqual([])
    })
  })

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

  it('draws enough placeholders to fill the row it is actually in', async () => {
    // This shelf and Home's Discover album shelf are the two slow enough to
    // load for anyone to see their loading state, which is where a fixed
    // count showed: on a wide window the row sat visibly half empty.
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1420)

    const wrapper = mountShelf([], true)
    // The row is measured on mount, i.e. after the first render — the
    // placeholders it decides on land on the next one.
    await nextTick()

    // Eight 160px cards with their 20px gaps fit in 1420px, plus one more
    // half off the edge so the row reads as continuing.
    expect(wrapper.findAll('.similar-artists-card')).toHaveLength(9)
    width.mockRestore()
  })

  it('keeps its own placeholder count where nothing can be measured', async () => {
    // jsdom lays nothing out — a width of zero must leave the default
    // standing rather than collapsing the row to a single card.
    const wrapper = mountShelf([], true)
    await nextTick()

    expect(wrapper.findAll('.similar-artists-card')).toHaveLength(6)
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
