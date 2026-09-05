import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import MobileLibraryView from '../MobileLibraryView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Album } from '@/types/library'

const vuetify = createVuetify({ components, directives })

function makeAlbum(id: string, overrides: Partial<Album> = {}): Album {
  return {
    id,
    name: `Album ${id}`,
    artist: `Artist ${id}`,
    artistId: `ar-${id}`,
    coverArtId: null,
    songCount: 2,
    duration: 300,
    year: 1999,
    genre: null,
    starred: false,
    rating: 0,
    songs: [],
    ...overrides,
  }
}

function mountView() {
  return mount(MobileLibraryView, {
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true, MobileSongActionSheet: true } },
  })
}

/** The store fetches on mount; both are stubbed so the view renders off
 * whatever is put into state here. */
function stubStore() {
  const library = useLibraryStore()
  vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
  vi.spyOn(library, 'fetchAlbums').mockResolvedValue()
  return library
}

async function switchTo(wrapper: ReturnType<typeof mountView>, label: string) {
  const button = wrapper.findAll('.segmented__option').find((b) => b.text() === label)!
  await button.trigger('click')
  await flushPromises()
}

describe('MobileLibraryView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts on songs', async () => {
    const library = stubStore()
    library.allSongs = [makeSong('a', { title: 'Track A' })]
    library.albums = [makeAlbum('1')]
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.findAllComponents({ name: 'MobileSongRow' })).toHaveLength(1)
    expect(wrapper.findAllComponents({ name: 'MobileAlbumRow' })).toHaveLength(0)
  })

  it('swaps the list for albums and loads them on the way', async () => {
    const library = stubStore()
    library.allSongs = [makeSong('a')]
    library.albums = [makeAlbum('1'), makeAlbum('2')]
    const wrapper = mountView()
    await flushPromises()

    await switchTo(wrapper, 'Albums')

    expect(wrapper.findAllComponents({ name: 'MobileAlbumRow' })).toHaveLength(2)
    expect(wrapper.findAllComponents({ name: 'MobileSongRow' })).toHaveLength(0)
    // The albums half is not fetched until it is actually asked for.
    expect(library.fetchAlbums).toHaveBeenCalled()
  })

  it('searches whichever half is showing', async () => {
    vi.useFakeTimers()
    const library = stubStore()
    library.allSongs = [makeSong('a', { title: 'Blue' }), makeSong('b', { title: 'Red' })]
    library.albums = [makeAlbum('1', { name: 'Blue Album' }), makeAlbum('2', { name: 'Red Album' })]
    const wrapper = mountView()
    await flushPromises()

    await switchTo(wrapper, 'Albums')
    await wrapper.get('input[type="text"]').setValue('blue')
    await vi.advanceTimersByTimeAsync(250)

    expect(wrapper.findAllComponents({ name: 'MobileAlbumRow' })).toHaveLength(1)
    vi.useRealTimers()
  })

  /** Noticing you are in the wrong half is usually what makes you switch,
   * so the term survives the switch and is applied to the other list -
   * retyping it would be the price of one tap. The field is clearable for
   * the rarer "start over" case. */
  it('keeps the search when the halves are switched and applies it to the other list', async () => {
    vi.useFakeTimers()
    const library = stubStore()
    library.allSongs = [makeSong('a', { title: 'Blue' }), makeSong('b', { title: 'Red' })]
    library.albums = [makeAlbum('1', { name: 'Blue Album' }), makeAlbum('2', { name: 'Red Album' })]
    const wrapper = mountView()
    await flushPromises()

    await wrapper.get('input[type="text"]').setValue('blue')
    await vi.advanceTimersByTimeAsync(250)
    expect(wrapper.findAllComponents({ name: 'MobileSongRow' })).toHaveLength(1)

    await switchTo(wrapper, 'Albums')
    await vi.advanceTimersByTimeAsync(250)

    expect((wrapper.get('input[type="text"]').element as HTMLInputElement).value).toBe('blue')
    expect(wrapper.findAllComponents({ name: 'MobileAlbumRow' })).toHaveLength(1)
    vi.useRealTimers()
  })

  /** The library list is the whole catalogue, or whatever the search
   * matched - a set of matches, not a running order. Tapping one song
   * queues that song, the same as the row's own action sheet already did
   * and the same as the desktop's Songs and search views. */
  it('plays only the tapped song, not the rest of the list', async () => {
    const library = stubStore()
    library.allSongs = [makeSong('a'), makeSong('b'), makeSong('c')]
    const playSongList = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const wrapper = mountView()
    await flushPromises()

    await wrapper.findAllComponents({ name: 'MobileSongRow' })[1]!.trigger('click')
    await flushPromises()

    expect(playSongList).toHaveBeenCalledTimes(1)
    const [songs, index] = playSongList.mock.calls[0]!
    expect(songs.map((song) => song.id)).toEqual(['b'])
    expect(index).toBe(0)
  })

  it('plays an album in its own track order', async () => {
    const library = stubStore()
    library.allSongs = []
    library.albums = [makeAlbum('1')]
    const songs = [makeSong('x'), makeSong('y')]
    vi.spyOn(library, 'fetchAlbum').mockResolvedValue(makeAlbum('1', { songs }))
    const playback = usePlaybackStore()
    const playSongList = vi.spyOn(playback, 'playSongList').mockResolvedValue()
    const wrapper = mountView()
    await flushPromises()
    await switchTo(wrapper, 'Albums')

    await wrapper.getComponent({ name: 'MobileAlbumRow' }).trigger('click')
    await flushPromises()

    // startIndex 0, pinFirst false, peek true — an album is a sequenced
    // work, not a pick made row by row.
    expect(playSongList).toHaveBeenCalledWith(songs, 0, false, true)
  })
})
