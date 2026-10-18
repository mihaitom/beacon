import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterLinkStub, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import MobileArtistDetailView from '../MobileArtistDetailView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Album } from '@/types/library'

const vuetify = createVuetify({ components, directives })

function makeAlbum(id: string, year: number | null): Album {
  return {
    id,
    name: `Album ${id}`,
    artist: 'Some Artist',
    artistId: 'ar-1',
    coverArtId: null,
    songCount: 1,
    duration: 1,
    year,
    genre: null,
    starred: false,
    rating: 0,
    songs: [],
  }
}

function makeArtist() {
  return {
    id: 'ar-1',
    name: 'Some Artist',
    albumCount: 3,
    coverArtId: null,
    imageUrl: null,
    starred: false,
    rating: 0,
    albums: [makeAlbum('old', 1990), makeAlbum('undated', null), makeAlbum('new', 2020)],
  }
}

function mountView(id = 'ar-1') {
  return mount(MobileArtistDetailView, {
    global: {
      plugins: [vuetify, i18n],
      stubs: { CoverArt: true, MobileSongActionSheet: true, RouterLink: RouterLinkStub },
      mocks: { $route: { params: { id } } },
    },
  })
}

describe('MobileArtistDetailView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  async function mountLoaded() {
    const library = useLibraryStore()
    vi.spyOn(library, 'fetchArtist').mockResolvedValue(makeArtist() as never)
    vi.spyOn(library, 'fetchTopSongsForArtist').mockResolvedValue([makeSong('a'), makeSong('b')])
    const wrapper = mountView()
    await flushPromises()
    return { wrapper, library }
  }

  it('shows the artist with their top songs and their albums, newest first', async () => {
    const { wrapper } = await mountLoaded()

    expect(wrapper.get('.page-title').text()).toBe('Some Artist')
    expect(wrapper.findAllComponents({ name: 'MobileSongRow' })).toHaveLength(2)
    // Undated albums have no place between two years and go last.
    expect(wrapper.findAllComponents(RouterLinkStub).map((link) => link.props('to'))).toEqual([
      '/m/albums/new',
      '/m/albums/old',
      '/m/albums/undated',
    ])
  })

  it('plays a tapped top song with the rest of them behind it', async () => {
    const { wrapper } = await mountLoaded()
    const playSongList = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()

    wrapper.findAllComponents({ name: 'MobileSongRow' })[1]!.vm.$emit('play')
    await flushPromises()

    expect(playSongList).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })],
      1,
    )
  })

  it('starts the artist radio where the server has one', async () => {
    useAuthStore().capabilities.songRadio = true
    const { wrapper } = await mountLoaded()
    const startArtistRadio = vi.spyOn(usePlaybackStore(), 'startArtistRadio').mockResolvedValue()

    await wrapper.get('.mobile-header .mdi-radio-tower').trigger('click')

    expect(startArtistRadio).toHaveBeenCalledWith(expect.objectContaining({ id: 'ar-1' }))
  })

  it('offers no artist radio where the server has none', async () => {
    useAuthStore().capabilities.songRadio = false
    const { wrapper } = await mountLoaded()

    expect(wrapper.find('.mobile-header .mdi-radio-tower').exists()).toBe(false)
  })
})
