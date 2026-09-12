import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import MobileAlbumDetailView from '../MobileAlbumDetailView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Album } from '@/types/library'

const vuetify = createVuetify({ components, directives })

function makeAlbum(overrides: Partial<Album> = {}): Album {
  return {
    id: 'al-1',
    name: 'Album One',
    artist: 'Some Artist',
    artistId: 'ar-1',
    coverArtId: null,
    songCount: 3,
    duration: 600,
    year: 1999,
    genre: null,
    starred: false,
    rating: 0,
    songs: [makeSong('a'), makeSong('b'), makeSong('c')],
    ...overrides,
  }
}

function mountView(id = 'al-1') {
  return mount(MobileAlbumDetailView, {
    global: {
      plugins: [vuetify, i18n],
      stubs: { CoverArt: true, MobileSongActionSheet: true },
      mocks: { $route: { params: { id } } },
    },
  })
}

describe('MobileAlbumDetailView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows the album with its tracks', async () => {
    const library = useLibraryStore()
    vi.spyOn(library, 'fetchAlbum').mockResolvedValue(makeAlbum())
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.get('.page-title').text()).toBe('Album One')
    expect(wrapper.text()).toContain('Some Artist')
    expect(wrapper.findAllComponents({ name: 'MobileSongRow' })).toHaveLength(3)
  })

  // The artist page does not exist in this shell (see the router's
  // m-album-detail comment), so nothing here may offer a way to it.
  it('names the artist without linking anywhere', async () => {
    const library = useLibraryStore()
    vi.spyOn(library, 'fetchAlbum').mockResolvedValue(makeAlbum())
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.findAll('a')).toHaveLength(0)
  })

  it('plays the album in its own order, and a tapped track with the rest behind it', async () => {
    const library = useLibraryStore()
    const album = makeAlbum()
    vi.spyOn(library, 'fetchAlbum').mockResolvedValue(album)
    const playback = usePlaybackStore()
    const playSongList = vi.spyOn(playback, 'playSongList').mockResolvedValue()
    const wrapper = mountView()
    await flushPromises()

    await wrapper.get('.mobile-header button').trigger('click')
    // pinFirst false: nobody picked the first track, so shuffle may move it.
    expect(playSongList).toHaveBeenLastCalledWith(album.songs, 0, false, true)

    await wrapper.findAllComponents({ name: 'MobileSongRow' })[1]!.vm.$emit('play')
    // pinFirst defaults to true here — this one *was* picked.
    expect(playSongList).toHaveBeenLastCalledWith(album.songs, 1)
  })

  it('opens the action sheet for the tapped row', async () => {
    const library = useLibraryStore()
    const album = makeAlbum()
    vi.spyOn(library, 'fetchAlbum').mockResolvedValue(album)
    const wrapper = mountView()
    await flushPromises()

    await wrapper.findAllComponents({ name: 'MobileSongRow' })[2]!.vm.$emit('open-actions')
    const sheet = wrapper.getComponent({ name: 'MobileSongActionSheet' })
    expect(sheet.props('modelValue')).toBe(true)
    expect(sheet.props('song')).toEqual(album.songs[2])
  })

  // An album that answers after the route has moved on must not paint over
  // whatever is on screen by then.
  it('drops a response that arrives after the route has changed', async () => {
    const library = useLibraryStore()
    let answer!: (album: Album) => void
    vi.spyOn(library, 'fetchAlbum').mockReturnValue(
      new Promise<Album>((resolve) => {
        answer = resolve
      }),
    )
    const wrapper = mountView('al-1')
    wrapper.vm.$route.params.id = 'al-2'
    answer(makeAlbum({ name: 'Stale Album' }))
    await flushPromises()

    expect(wrapper.text()).not.toContain('Stale Album')
  })
})
