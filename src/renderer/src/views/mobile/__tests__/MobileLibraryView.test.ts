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
import type { Album, Artist } from '@/types/library'

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

/** flushPromises, and one timer tick on top: an open-able menu in the view
 * (Vuetify's overlays, for closing on the back button) holds every
 * navigation for a setTimeout, which promises alone never wait for. */
async function settle() {
  await flushPromises()
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1)
  else await new Promise((resolve) => setTimeout(resolve, 0))
  await flushPromises()
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
  vi.spyOn(library, 'fetchArtists').mockResolvedValue()
  return library
}

async function switchTo(wrapper: ReturnType<typeof mountView>, label: string) {
  const button = wrapper.findAll('.segmented__option').find((b) => b.text() === label)!
  await button.trigger('click')
  await settle()
}

describe('MobileLibraryView', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    // Orders and layouts are remembered on the device.
    localStorage.clear()
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
    await settle()

    expect(wrapper.findAllComponents({ name: 'MobileSongRow' })).toHaveLength(1)
    expect(wrapper.findAllComponents({ name: 'MobileAlbumRow' })).toHaveLength(0)
  })

  it('swaps the list for albums and loads them on the way', async () => {
    const library = stubStore()
    library.allSongs = [makeSong('a')]
    library.albums = [makeAlbum('1'), makeAlbum('2')]
    const wrapper = mountView()
    await settle()

    await switchTo(wrapper, 'Albums')

    expect(wrapper.findAllComponents({ name: 'MobileAlbumRow' })).toHaveLength(2)
    expect(wrapper.findAllComponents({ name: 'MobileSongRow' })).toHaveLength(0)
    // The albums half is not fetched until it is actually asked for.
    expect(library.fetchAlbums).toHaveBeenCalled()
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
    await settle()

    await wrapper.findAllComponents({ name: 'MobileSongRow' })[1]!.trigger('click')
    await settle()

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
    await settle()
    await switchTo(wrapper, 'Albums')

    await wrapper.get('.mobile-album-row button').trigger('click')
    await settle()

    // startIndex 0, pinFirst false, peek true — an album is a sequenced
    // work, not a pick made row by row.
    expect(playSongList).toHaveBeenCalledWith(songs, 0, false, true)
  })

  // Opening an album unmounts this view, so anything it kept in data()
  // alone is gone by the time the back button brings it up again. Reported
  // live: a search, an album, back, and the results were the whole library
  // again on the wrong half.
  describe('coming back from an album', () => {
    it('finds the half it was on still there', async () => {
      const library = stubStore()
      library.allSongs = [makeSong('a')]
      library.albums = [makeAlbum('1'), makeAlbum('2')]
      const first = mountView()
      await settle()
      await switchTo(first, 'Albums')

      // The address is what survives the unmount, so a fresh mount on the
      // same route is what the back button produces. Mounted before the
      // first goes: the router forgets its route once no app is left on it,
      // which in the app never happens.
      const wrapper = mountView()
      first.unmount()
      await settle()

      expect(wrapper.findAllComponents({ name: 'MobileAlbumRow' })).toHaveLength(2)
      expect(wrapper.findAllComponents({ name: 'MobileSongRow' })).toHaveLength(0)
    })

    it('does not make a switch of half a step on the way back', async () => {
      // A real entry to go back to, so "one step back" has somewhere to
      // land other than the start of the history.
      await router.push('/m/now-playing')
      await router.push('/m/library')
      const library = stubStore()
      library.allSongs = []
      library.albums = [makeAlbum('1')]
      const wrapper = mountView()
      await settle()
      await switchTo(wrapper, 'Albums')
      await switchTo(wrapper, 'Artists')
      expect(router.currentRoute.value.query.tab).toBe('artists')

      router.back()
      await settle()
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
    await settle()
    await switchTo(wrapper, 'Albums')

    expect(wrapper.get('.mobile-album-row').attributes('href')).toBe('/m/albums/1')
  })

  it('lists the artists, loading them on the way, each leading to its page', async () => {
    const library = stubStore()
    library.allSongs = []
    library.artists = [
      { id: 'ar1', name: 'Blue Band', albumCount: 2 } as Artist,
      { id: 'ar2', name: 'Red Band', albumCount: 1 } as Artist,
    ]
    const wrapper = mountView()
    await settle()

    await switchTo(wrapper, 'Artists')

    expect(library.fetchArtists).toHaveBeenCalled()
    const rows = wrapper.findAll('.mobile-artist-row')
    expect(rows.map((row) => row.attributes('href'))).toEqual(['/m/artists/ar1', '/m/artists/ar2'])
    expect(router.currentRoute.value.query.tab).toBe('artists')
  })

  // The desktop's controls for a library list (discussion #103): how it is
  // laid out, what it is narrowed to, and in which order.
  describe('browsing like the desktop', () => {
    it('puts the albums in the order picked, and remembers it', async () => {
      const library = stubStore()
      library.allSongs = []
      library.albums = [
        makeAlbum('1', { name: 'A Old', year: 1970 }),
        makeAlbum('2', { name: 'B New', year: 2020 }),
      ]
      const wrapper = mountView()
      await settle()
      await switchTo(wrapper, 'Albums')
      const names = (w: ReturnType<typeof mountView>) =>
        w.findAll('.mobile-album-row .text-body-medium').map((row) => row.text())

      wrapper.getComponent({ name: 'LibrarySortSelect' }).vm.$emit('update:modelValue', 'year')
      await settle()
      // Newest first, the desktop's own default for a year.
      expect(names(wrapper)).toEqual(['B New', 'A Old'])

      const again = mountView()
      await settle()
      await switchTo(again, 'Albums')
      expect(names(again)).toEqual(['B New', 'A Old'])

      again.getComponent({ name: 'LibrarySortSelect' }).vm.$emit('toggle-direction')
      await settle()
      expect(names(again)).toEqual(['A Old', 'B New'])
    })

    it('puts the songs in the order picked', async () => {
      const library = stubStore()
      library.allSongs = [makeSong('a', { title: 'Alpha' }), makeSong('b', { title: 'Beta' })]
      const wrapper = mountView()
      await settle()

      wrapper.getComponent({ name: 'LibrarySortSelect' }).vm.$emit('toggle-direction')
      await settle()

      const titles = wrapper.findAll('.mobile-song-row .text-body-medium').map((row) => row.text())
      expect(titles).toEqual(['Beta', 'Alpha'])
    })

    it('narrows a half to what the filter picks, and only that half', async () => {
      const library = stubStore()
      library.allSongs = [
        makeSong('a', { title: 'Rock One', genre: 'Rock' }),
        makeSong('b', { title: 'Jazz One', genre: 'Jazz' }),
      ]
      library.albums = [makeAlbum('1'), makeAlbum('2')]
      const wrapper = mountView()
      await settle()

      wrapper
        .getComponent({ name: 'LibraryFilterMenu' })
        .vm.$emit('update:modelValue', { genre: ['Jazz'] })
      await settle()
      const songs = wrapper.findAllComponents({ name: 'MobileSongRow' })
      expect(songs).toHaveLength(1)
      expect(songs[0]!.text()).toContain('Jazz One')
      // The phone's filter is an icon without a label, so its count is the
      // one sign that the list is narrowed at all.
      expect(wrapper.get('.library-filter-button').text()).toContain('1')

      await switchTo(wrapper, 'Albums')
      expect(wrapper.findAllComponents({ name: 'MobileAlbumRow' })).toHaveLength(2)
      expect(wrapper.get('.library-filter-button').text()).not.toContain('1')
    })

    it('lays the albums out as cards that open them, remembered per half', async () => {
      const library = stubStore()
      library.allSongs = [makeSong('x')]
      library.albums = [makeAlbum('1')]
      const wrapper = mountView()
      await settle()
      await switchTo(wrapper, 'Albums')

      wrapper.getComponent({ name: 'VBtnToggle' }).vm.$emit('update:modelValue', 'grid')
      await settle()
      expect(wrapper.get('.mobile-grid-tile').attributes('href')).toBe('/m/albums/1')
      expect(wrapper.findAllComponents({ name: 'MobileAlbumRow' })).toHaveLength(0)

      // The songs keep their own layout.
      await switchTo(wrapper, 'Songs')
      expect(wrapper.findAllComponents({ name: 'MobileSongRow' })).toHaveLength(1)

      const again = mountView()
      await settle()
      await switchTo(again, 'Albums')
      expect(again.findAll('.mobile-grid-tile')).toHaveLength(1)
    })

    it("plays a song from its card's cover, and leads to its album from the title", async () => {
      const library = stubStore()
      library.allSongs = [makeSong('a'), makeSong('b', { albumId: 'al-b' })]
      const playSongList = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
      const wrapper = mountView()
      await settle()

      wrapper.getComponent({ name: 'VBtnToggle' }).vm.$emit('update:modelValue', 'grid')
      await settle()
      const card = wrapper.findAll('.mobile-grid-tile')[1]!
      await card.get('.mobile-grid-tile__cover').trigger('click')
      await settle()

      expect(playSongList).toHaveBeenCalledWith([library.allSongs[1]], 0)
      expect(card.get('a.mobile-grid-tile__title').attributes('href')).toBe('/m/albums/al-b')
    })

    it('puts a divider before each section, in either layout', async () => {
      const library = stubStore()
      library.allSongs = []
      library.albums = [
        makeAlbum('1', { name: 'Abba Gold' }),
        makeAlbum('2', { name: 'Arrival' }),
        makeAlbum('3', { name: 'Beatles 1' }),
      ]
      const wrapper = mountView()
      await settle()
      await switchTo(wrapper, 'Albums')
      const dividers = () => wrapper.findAll('.letter-divider').map((d) => d.text())

      expect(dividers()).toEqual(['A', 'B'])

      wrapper.getComponent({ name: 'VBtnToggle' }).vm.$emit('update:modelValue', 'grid')
      await settle()
      expect(dividers()).toEqual(['A', 'B'])
      // That a row never spans two sections is sectionedRows.test.ts's.
    })

    it('says on each row what the list is sorted by', async () => {
      const library = stubStore()
      library.allSongs = [
        makeSong('a', { title: 'Often', artist: 'Band', playCount: 12 }),
        makeSong('b', { title: 'Once', artist: 'Band', playCount: 1 }),
      ]
      const wrapper = mountView()
      await settle()
      const subtitles = () =>
        wrapper
          .findAll('.mobile-song-row .text-body-small')
          .map((line) => line.findAll(':scope > *').map((part) => part.text()))
      // By title, the row's own two lines already say it all.
      expect(subtitles()).toEqual([['Band'], ['Band']])

      wrapper.getComponent({ name: 'LibrarySortSelect' }).vm.$emit('update:modelValue', 'playCount')
      await settle()

      // The artist, and at the line's end what the order goes by.
      expect(subtitles()).toEqual([
        ['Band', i18n.global.t('home.playCount', { n: 12 }, 12)],
        ['Band', i18n.global.t('home.playCount', { n: 1 }, 1)],
      ])
    })

    it('names a decade in the dividers when sorted by year', async () => {
      const library = stubStore()
      library.allSongs = []
      library.albums = [makeAlbum('1', { year: 1985 }), makeAlbum('2', { year: null as never })]
      const wrapper = mountView()
      await settle()
      await switchTo(wrapper, 'Albums')

      wrapper.getComponent({ name: 'LibrarySortSelect' }).vm.$emit('update:modelValue', 'year')
      await settle()

      expect(wrapper.findAll('.letter-divider').map((d) => d.text())).toEqual([
        i18n.global.t('library.decade', { decade: '1980' }),
        i18n.global.t('library.unknownYear'),
      ])
    })
  })
})
