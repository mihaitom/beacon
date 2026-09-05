// The right-click menus on library tiles, and the full-size artwork viewer
// they (and the detail headers) open. What is deliberately *not* covered
// here is CoverArt.vue's own `fullSize` resolution bump, which has its own
// test next door (CoverArt.test.ts) where the request-capturing harness
// already lives.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import type { ArtworkView } from '@/types/events'
import type { Album, Artist, Playlist } from '@/types/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import TileContextMenu from '../TileContextMenu.vue'
import CreatePlaylistDialog from '../CreatePlaylistDialog.vue'
import ArtworkLightbox from '../ArtworkLightbox.vue'
import DetailHeader from '../DetailHeader.vue'
import AlbumCard from '../AlbumCard.vue'
import ArtistCard from '../ArtistCard.vue'
import PlaylistTile from '../PlaylistTile.vue'

const vuetify = createVuetify({ components, directives })

const globalOptions = {
  plugins: [vuetify, i18n],
  stubs: { CoverArt: true, RouterLink: true },
  mocks: { $router: { push: vi.fn() } },
}

/** Everything the viewer was asked to show while `run` was running. */
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

function rightClick(wrapper: { trigger: (event: string, payload?: object) => Promise<unknown> }) {
  return wrapper.trigger('contextmenu', { clientX: 120, clientY: 80 })
}

function menuOf(wrapper: ReturnType<typeof mount>) {
  return wrapper.findComponent(TileContextMenu).vm as unknown as {
    menuOpen: boolean
    menuId: number
  }
}

/** The rendered entries of an open menu. Menus render into an overlay
 * outside the component's own tree, so this reads the document. */
function menuLabels(): string[] {
  return [...document.querySelectorAll('.v-overlay-container .v-list-item-title')].map(
    (item) => item.textContent?.trim() ?? '',
  )
}

const album: Album = {
  id: 'al-1',
  name: 'Slow Return',
  artist: 'Tinlicker',
  artistId: 'ar-1',
  coverArtId: 'cover-1',
  year: 2024,
  genre: null,
  starred: false,
  rating: 0,
  songCount: 2,
  duration: 400,
  songs: [],
}

const artist: Artist = {
  id: 'ar-1',
  name: 'Tinlicker',
  coverArtId: 'ar-cover',
  imageUrl: 'https://cdn.example/tinlicker.jpg',
  albumCount: 4,
  starred: false,
  rating: 0,
  albums: [],
}

const playlist: Playlist = {
  id: 'p1',
  name: 'Late shift',
  songCount: 2,
  duration: 400,
  coverArtId: 'pl-cover',
  public: false,
  owner: 'thomas',
  songs: [],
}

const albumSongs = [makeSong('a'), makeSong('b')]

describe('tile context menus', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().username = 'thomas'
    // Opening any of these menus loads the playlists for its "Add to
    // playlist" submenu, and the real action goes out over the network:
    // every test here that right-clicks a tile was firing a live request
    // at the media server proxy on localhost:7071. That surfaced as
    // intermittent unhandled ECONNREFUSED rejections in a full suite run
    // (never in this file alone, which is why it stayed hidden) — and
    // worse, on a machine where the dev backend happens to be up it is a
    // real request against a real library. Same reasoning as the backend
    // suite's own network-blocking fixtures: one predictable answer for
    // whatever a test did not think to stub itself.
    vi.spyOn(useLibraryStore(), 'fetchPlaylists').mockResolvedValue()
  })

  afterEach(() => {
    emitter.all.clear()
    document.body.innerHTML = ''
  })

  describe('an album tile', () => {
    function mountCard() {
      return mount(AlbumCard, { props: { album }, global: globalOptions })
    }

    it('opens on right-click without following the tile own click', async () => {
      const wrapper = mountCard()

      await rightClick(wrapper)

      expect(menuOf(wrapper).menuOpen).toBe(true)
      expect(globalOptions.mocks.$router.push).not.toHaveBeenCalled()
    })

    it('plays the album track list, which a tile does not carry itself', async () => {
      const library = useLibraryStore()
      const fetchAlbum = vi
        .spyOn(library, 'fetchAlbum')
        .mockResolvedValue({ ...album, songs: albumSongs })
      const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
      const wrapper = mountCard()

      await rightClick(wrapper)
      await (wrapper.vm as unknown as { play(): Promise<void> }).play()

      expect(fetchAlbum).toHaveBeenCalledWith('al-1')
      expect(play).toHaveBeenCalledWith(albumSongs, 0, false, true)
    })

    it('queues it next, and at the end, from the same fetched list', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchAlbum').mockResolvedValue({ ...album, songs: albumSongs })
      const playback = usePlaybackStore()
      const queueNext = vi.spyOn(playback, 'queueNext').mockImplementation(() => {})
      const addToQueue = vi.spyOn(playback, 'addToQueue').mockImplementation(() => {})
      const wrapper = mountCard()
      const vm = wrapper.vm as unknown as {
        playNext(): Promise<void>
        addToQueue(): Promise<void>
      }

      await vm.playNext()
      await vm.addToQueue()

      expect(queueNext).toHaveBeenCalledWith(albumSongs)
      expect(addToQueue).toHaveBeenCalledWith(albumSongs)
    })

    it('says so instead of queueing nothing when the track list cannot be loaded', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchAlbum').mockRejectedValue(new Error('server down'))
      const playback = usePlaybackStore()
      const addToQueue = vi.spyOn(playback, 'addToQueue').mockImplementation(() => {})
      const toasts: unknown[] = []
      emitter.on('toast', (toast) => toasts.push(toast))
      const wrapper = mountCard()

      await (wrapper.vm as unknown as { addToQueue(): Promise<void> }).addToQueue()

      expect(addToQueue).not.toHaveBeenCalled()
      expect(toasts).toHaveLength(1)
    })

    it('adds the album to a playlist as a whole', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchAlbum').mockResolvedValue({ ...album, songs: albumSongs })
      const add = vi.spyOn(library, 'addToPlaylist').mockResolvedValue()
      const wrapper = mountCard()

      await (wrapper.vm as unknown as { addToPlaylist(id: string): Promise<void> }).addToPlaylist(
        'p1',
      )

      expect(add).toHaveBeenCalledWith('p1', ['a', 'b'])
    })

    it('seeds a brand new playlist with the whole album', async () => {
      // The dialog is shared with SongTable.vue's own "Create new
      // playlist…", which seeds it with a song or a selection instead —
      // what it is handed is the caller's business, creating it is the
      // dialog's.
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchAlbum').mockResolvedValue({ ...album, songs: albumSongs })
      const create = vi.spyOn(library, 'createPlaylist').mockResolvedValue()
      const wrapper = mountCard()

      await (wrapper.vm as unknown as { createPlaylist(): Promise<void> }).createPlaylist()
      const dialog = wrapper.findComponent(CreatePlaylistDialog).vm as unknown as {
        visible: boolean
        name: string
        confirm(): Promise<void>
      }
      expect(dialog.visible).toBe(true)
      dialog.name = 'Night drive'
      await dialog.confirm()

      expect(create).toHaveBeenCalledWith('Night drive', ['a', 'b'])
      expect(dialog.visible).toBe(false)
    })

    it('fetches the playlists once, when the menu opens rather than when it is hovered', async () => {
      const fetchPlaylists = useLibraryStore().fetchPlaylists
      const wrapper = mountCard()

      await rightClick(wrapper)

      expect(fetchPlaylists).toHaveBeenCalledOnce()
    })
  })

  describe('an artist tile', () => {
    function mountCard() {
      return mount(ArtistCard, { props: { artist }, global: globalOptions })
    }

    it('offers Artist Radio, and starts the same mix the artist page does', async () => {
      const start = vi.spyOn(usePlaybackStore(), 'startArtistRadio').mockResolvedValue()
      const wrapper = mountCard()

      await rightClick(wrapper)
      expect(menuLabels()).toContain(i18n.global.t('library.artistRadio'))

      await (wrapper.vm as unknown as { startArtistRadio(): Promise<void> }).startArtistRadio()
      expect(start).toHaveBeenCalledWith(artist)
    })

    it('leaves Artist Radio out on a server that has no such thing', async () => {
      // Plex without a Plex Pass, and anything else capabilities.songRadio
      // is false for — the same gate the artist page's own button uses.
      useAuthStore().capabilities.songRadio = false
      const wrapper = mountCard()

      await rightClick(wrapper)

      expect(menuLabels()).not.toContain(i18n.global.t('library.artistRadio'))
      expect(menuLabels()).toContain(i18n.global.t('library.playAll'))
    })

    it('reports a failed Artist Radio rather than looking like nothing happened', async () => {
      vi.spyOn(usePlaybackStore(), 'startArtistRadio').mockRejectedValue(new Error('nope'))
      const toasts: unknown[] = []
      emitter.on('toast', (toast) => toasts.push(toast))
      const wrapper = mountCard()

      await (wrapper.vm as unknown as { startArtistRadio(): Promise<void> }).startArtistRadio()

      expect(toasts).toHaveLength(1)
    })

    it('plays everything the artist has', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchAllSongsForArtist').mockResolvedValue(albumSongs)
      const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
      const wrapper = mountCard()

      await (wrapper.vm as unknown as { play(): Promise<void> }).play()

      expect(play).toHaveBeenCalledWith(albumSongs, 0, false, true)
    })
  })

  describe('a playlist tile', () => {
    // A real router rather than globalOptions' RouterLink stub: this tile's
    // root *is* the link, and the stub swallows the @contextmenu listener
    // that is the whole subject here.
    function mountTile(overrides: Partial<Playlist> = {}) {
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
      })
      return mount(PlaylistTile, {
        props: { playlist: { ...playlist, ...overrides } },
        global: { ...globalOptions, plugins: [vuetify, i18n, router], stubs: { CoverArt: true } },
      })
    }

    it('offers renaming and deleting, which used to need opening the playlist first', async () => {
      const wrapper = mountTile()

      await rightClick(wrapper)

      expect(menuLabels()).toContain(i18n.global.t('common.edit'))
      expect(menuLabels()).toContain(i18n.global.t('common.delete'))
    })

    it('leaves both out for a playlist belonging to someone else', async () => {
      const wrapper = mountTile({ owner: 'someone-else' })

      await rightClick(wrapper)

      expect(menuLabels()).not.toContain(i18n.global.t('common.edit'))
      expect(menuLabels()).not.toContain(i18n.global.t('common.delete'))
      // Playing it is still fine — a shared playlist is readable.
      expect(menuLabels()).toContain(i18n.global.t('library.play'))
    })

    it('hands the queue actions up to the view, which is what can fetch the songs', async () => {
      const wrapper = mountTile()

      await rightClick(wrapper)
      wrapper.findAllComponents({ name: 'VListItem' })[1]!.trigger('click')

      expect(wrapper.emitted('play-next')?.[0]).toEqual([{ ...playlist }])
    })
  })

  describe('one menu at a time', () => {
    it('closes when another menu opens, and stays open on its own broadcast', async () => {
      // Every context menu in the app shares one id source (see
      // services/contextMenu.ts) precisely so this holds across the
      // different kinds — a song row's menu and a tile's used to be able to
      // draw the same id and each read the other's broadcast as its own.
      const wrapper = mount(AlbumCard, { props: { album }, global: globalOptions })
      await rightClick(wrapper)
      const menu = menuOf(wrapper)

      emitter.emit('contextMenuOpened', menu.menuId)
      expect(menu.menuOpen).toBe(true)

      emitter.emit('contextMenuOpened', menu.menuId + 1000)
      expect(menu.menuOpen).toBe(false)
    })

    it('closes on a right-click anywhere else, including where no menu opens', async () => {
      // Vuetify dismisses an overlay on a left click outside it, but not on
      // a right one — that fires no `click` at all. Without the document
      // listener in services/contextMenu.ts, right-clicking the page
      // background left the previous menu sitting open.
      const wrapper = mount(AlbumCard, { props: { album }, global: globalOptions })
      await rightClick(wrapper)
      const menu = menuOf(wrapper)
      expect(menu.menuOpen).toBe(true)

      document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))

      expect(menu.menuOpen).toBe(false)
    })

    it('goes away when the page scrolls, rather than drifting or freezing it', async () => {
      // A menu anchored to a point has nothing to stay glued to while the
      // page moves. Blocking the scroll instead (a dialog's strategy) was
      // tried and had to be reverted — see TileContextMenu.vue's own
      // comment and the real-browser test next door, which is where that
      // failure is actually observable.
      const wrapper = mount(AlbumCard, { props: { album }, global: globalOptions })

      expect(wrapper.findComponent({ name: 'VMenu' }).props('scrollStrategy')).toBe('close')
    })
  })
})

describe('opening the artwork viewer from a detail page header', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    emitter.all.clear()
  })

  it('shows the item the header is about', () => {
    const wrapper = mount(DetailHeader, {
      props: { title: 'Slow Return', eyebrow: 'Album', coverArtId: 'cover-1' },
      global: globalOptions,
    })

    const views = shown(() => {
      void wrapper.find('.detail-header__cover').trigger('click')
    })

    expect(views).toEqual([
      expect.objectContaining({ coverArtId: 'cover-1', title: 'Slow Return' }),
    ])
  })

  it('carries the artist treatment through, rather than squaring a photo off', () => {
    const wrapper = mount(DetailHeader, {
      props: { title: 'Tinlicker', imageUrl: 'https://cdn.example/a.jpg', rounded: true },
      global: globalOptions,
    })

    const views = shown(() => {
      void wrapper.find('.detail-header__cover').trigger('click')
    })

    expect(views[0]).toMatchObject({ rounded: true, imageUrl: 'https://cdn.example/a.jpg' })
  })

  it('offers nothing to open when the header is showing a placeholder icon', () => {
    const wrapper = mount(DetailHeader, {
      props: { title: 'Nothing here' },
      global: globalOptions,
    })

    const views = shown(() => {
      void wrapper.find('.detail-header__cover').trigger('click')
    })

    expect(views).toEqual([])
    expect(wrapper.find('.detail-header__cover--zoomable').exists()).toBe(false)
  })
})

describe('ArtworkLightbox', () => {
  afterEach(() => {
    emitter.all.clear()
  })

  function mountLightbox() {
    return mount(ArtworkLightbox, { global: globalOptions })
  }

  it('opens on the event, with the artwork asked for at full size', async () => {
    const wrapper = mountLightbox()

    emitter.emit('showArtwork', { coverArtId: 'cover-1', title: 'Slow Return', subtitle: 'Album' })
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.visible).toBe(true)
    // Rendered into an overlay outside this wrapper's own tree, so the
    // props are read off the component rather than found in its HTML.
    const art = wrapper.findComponent({ name: 'CoverArt' })
    expect(art.props('fullSize')).toBe(true)
    expect(art.props('coverArtId')).toBe('cover-1')
  })

  it('keeps showing the artwork while the dialog is fading out', async () => {
    // Clearing it together with `visible` blanks the picture mid-animation,
    // while the overlay is still on screen showing it.
    const wrapper = mountLightbox()
    emitter.emit('showArtwork', { coverArtId: 'cover-1', title: 'Slow Return' })
    await wrapper.vm.$nextTick()

    wrapper.vm.visible = false
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.view).toMatchObject({ coverArtId: 'cover-1' })
  })

  it('stops listening once it is gone', () => {
    const wrapper = mountLightbox()
    wrapper.unmount()

    // Nothing to assert beyond "this does not throw and nothing is shown":
    // a listener left behind would keep a torn-down component reachable.
    expect(() => emitter.emit('showArtwork', { title: 'Whatever' })).not.toThrow()
  })
})
