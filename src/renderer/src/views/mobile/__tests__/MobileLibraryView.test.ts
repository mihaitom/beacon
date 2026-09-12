import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import { createMemoryHistory, createRouter } from 'vue-router'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import MobileLibraryView from '../MobileLibraryView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Album } from '@/types/library'

const vuetify = createVuetify({ components, directives })

// MobileAlbumRow is a link to the album page — without a real router its
// <router-link> resolves to nothing and the row under test is not the one
// that ships.
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
})

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
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { CoverArt: true, MobileSongActionSheet: true },
    },
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
  beforeEach(async () => {
    setActivePinia(createPinia())
    // The view writes its search and its half into the address (see
    // rememberSearch) and reads them back on mount, so a route left over
    // from the previous test would decide where this one starts.
    await router.replace('/')
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

    await wrapper.get('.mobile-album-row button').trigger('click')
    await flushPromises()

    // startIndex 0, pinFirst false, peek true — an album is a sequenced
    // work, not a pick made row by row.
    expect(playSongList).toHaveBeenCalledWith(songs, 0, false, true)
  })

  // Opening an album unmounts this view, so anything it kept in data()
  // alone is gone by the time the back button brings it up again. Reported
  // live: a search, an album, back, and the results were the whole library
  // again on the wrong half.
  describe('coming back from an album', () => {
    async function searchThenLeave() {
      const library = stubStore()
      library.allSongs = [makeSong('a', { title: 'Blue Song' })]
      library.albums = [makeAlbum('1', { name: 'Blue Album' }), makeAlbum('2', { name: 'Red' })]
      const wrapper = mountView()
      await flushPromises()
      await switchTo(wrapper, 'Albums')
      await wrapper.get('input[type="text"]').setValue('Blue')
      await new Promise((resolve) => setTimeout(resolve, 250))
      await flushPromises()
      expect(wrapper.findAllComponents({ name: 'MobileAlbumRow' })).toHaveLength(1)
      wrapper.unmount()
      return library
    }

    it('finds the search and the half it was on still there', async () => {
      await searchThenLeave()

      // The address is what survives the unmount, so a fresh mount on the
      // same route is exactly what the back button produces.
      const wrapper = mountView()
      await flushPromises()

      expect(wrapper.findAllComponents({ name: 'MobileAlbumRow' })).toHaveLength(1)
      expect(wrapper.findAllComponents({ name: 'MobileSongRow' })).toHaveLength(0)
      expect((wrapper.get('input[type="text"]').element as HTMLInputElement).value).toBe('Blue')
    })

    it('does not turn every keystroke into a step on the way back', async () => {
      // A real entry to go back to, so "one step back" has somewhere to
      // land other than the start of the history.
      await router.push('/m/now-playing')
      await router.push('/m/library')

      const library = stubStore()
      library.allSongs = []
      library.albums = [makeAlbum('1', { name: 'Blue Album' }), makeAlbum('2', { name: 'Red' })]
      const wrapper = mountView()
      await flushPromises()
      await switchTo(wrapper, 'Albums')
      for (const term of ['B', 'Bl', 'Blu', 'Blue']) {
        await wrapper.get('input[type="text"]').setValue(term)
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      await flushPromises()
      expect(router.currentRoute.value.query.q).toBe('Blue')

      // replace(), not push(): one step leaves the library instead of
      // walking the search backwards a letter at a time.
      router.back()
      await flushPromises()
      expect(router.currentRoute.value.path).toBe('/m/now-playing')
    })
  })

  // The row itself opens the album rather than playing it. That the play
  // button does *not* also navigate cannot be answered here - jsdom runs no
  // anchor activation - and is covered in MobileAlbumRow.browser.test.ts.
  it('links each album row to its page', async () => {
    const library = stubStore()
    library.allSongs = []
    library.albums = [makeAlbum('1')]
    vi.spyOn(library, 'fetchAlbum').mockResolvedValue(makeAlbum('1', { songs: [makeSong('x')] }))
    vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const wrapper = mountView()
    await flushPromises()
    await switchTo(wrapper, 'Albums')

    expect(wrapper.get('.mobile-album-row').attributes('href')).toBe('/m/albums/1')
  })
})
