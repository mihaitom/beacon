import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import ArtistCard from '../ArtistCard.vue'
import { useLibraryStore } from '@/stores/library'
import type { Artist } from '@/types/library'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function makeArtist(overrides: Partial<Artist> = {}): Artist {
  return {
    id: 'a1',
    name: 'Yeah Yeah Yeahs',
    albumCount: 0,
    coverArtId: null,
    imageUrl: null,
    starred: false,
    rating: 0,
    albums: [],
    ...overrides,
  }
}

function mountCard(artist: Artist) {
  return mount(ArtistCard, {
    props: { artist },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true, TileContextMenu: true } },
  })
}

/**
 * The track figure is counted out of the loaded catalogue, not read off the
 * server - no Subsonic server reports one (ArtistID3 carries albumCount and
 * nothing else), and albums are exactly what these artists lack.
 */
describe('ArtistCard counts', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('shows both figures, which is what makes an artist with no album readable', () => {
    const store = useLibraryStore()
    store.allSongs = [
      makeSong('s1', { artist: 'Yeah Yeah Yeahs' }),
      makeSong('s2', { artist: 'Someone & Yeah Yeah Yeahs' }),
      makeSong('s3', { artist: 'Nobody At All' }),
    ]
    store.allSongsLoaded = true

    const wrapper = mountCard(makeArtist())

    expect(wrapper.findAll('.artist-card-count')).toHaveLength(2)
    // The guest spot counts: a server figure would have missed it, and it
    // is the case the whole feature is for.
    expect(wrapper.find('.artist-card-meta').text()).toContain('2')
  })

  it('says nothing at all until the catalogue has arrived', () => {
    // Not 0, which would be a wrong number rather than a missing one - and
    // an icon with a blank beside it is what shipped by accident once.
    const wrapper = mountCard(makeArtist())

    expect(wrapper.findAll('.artist-card-count')).toHaveLength(1)
    expect(wrapper.find('.artist-card-meta').text().trim()).toBe('0')
  })

  it('shows a real zero once it can be sure of it', () => {
    const store = useLibraryStore()
    store.allSongs = [makeSong('s1', { artist: 'Nobody At All' })]
    store.allSongsLoaded = true

    const wrapper = mountCard(makeArtist())

    expect(wrapper.findAll('.artist-card-count')).toHaveLength(2)
  })
})
