import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import PlaylistDetailView from '../PlaylistDetailView.vue'
import PlaylistDeleteDialog from '@/components/library/PlaylistDeleteDialog.vue'
import SongTable from '@/components/library/SongTable.vue'
import PlaylistNotice from '@/components/library/PlaylistNotice.vue'
import type { Playlist, Song } from '@/types/library'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function makePlaylist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: 'p1',
    name: 'My mix',
    songCount: 0,
    duration: 0,
    coverArtId: null,
    public: false,
    owner: 'thomas',
    songs: [],
    ...overrides,
  }
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/playlists', component: { template: '<div />' } },
      { path: '/playlists/:id', component: PlaylistDetailView },
    ],
  })
}

async function mountView(id = 'p1') {
  const router = makeRouter()
  await router.push(`/playlists/${id}`)
  await router.isReady()
  const host = mount(
    { components: { PlaylistDetailView }, template: '<v-app><router-view /></v-app>' },
    {
      global: {
        plugins: [vuetify, i18n, router],
        // Not registered anywhere in the test setup (see setup.ts) — the
        // error-path test below reaches remove()'s catch block, which
        // calls this to show a toast; without a stub that's a TypeError
        // on undefined instead of the failure path actually under test.
        // `on`/`off` as well as emit: with songs in the playlist this
        // also mounts real SongRows, which subscribe to it on mount.
        mocks: { $emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
      },
    },
  )
  await flushPromises()
  const wrapper = host.findComponent(PlaylistDetailView)
  return { wrapper, host, router }
}

describe('PlaylistDetailView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('deleting a playlist', () => {
    // The confirmation itself lives in PlaylistDeleteDialog.vue, shared
    // with the playlists overview's own tile menu — this view's part is
    // opening it and deciding what happens afterwards (navigating away).
    function deleteDialogOf(wrapper: ReturnType<typeof mount>) {
      return wrapper.findComponent(PlaylistDeleteDialog).vm as unknown as {
        visible: boolean
        confirm(): Promise<void>
      }
    }

    /** Opens it the way the page does — the dialog is told *which*
     * playlist by that click, so a test that only flips `visible` would be
     * confirming a deletion of nothing. */
    async function openDeleteDialog(wrapper: ReturnType<typeof mount>) {
      const button = wrapper.get('.mdi-delete-outline').element.closest('button')!
      await button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return deleteDialogOf(wrapper)
    }

    it('opens a confirmation dialog instead of deleting right away', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchPlaylist').mockResolvedValue(makePlaylist())
      const deleteSpy = vi.spyOn(library, 'deletePlaylist').mockResolvedValue()
      const { wrapper } = await mountView()

      const deleteBtn = wrapper.get('.mdi-delete-outline').element.closest('button')!
      await deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      expect(deleteDialogOf(wrapper).visible).toBe(true)
      expect(deleteSpy).not.toHaveBeenCalled()
    })

    it('deletes and navigates back to the list once confirmed', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchPlaylist').mockResolvedValue(makePlaylist())
      const deleteSpy = vi.spyOn(library, 'deletePlaylist').mockResolvedValue()
      const { wrapper, router } = await mountView()
      const dialog = await openDeleteDialog(wrapper)

      await dialog.confirm()
      // The navigation fires without being awaited (same established
      // pattern as every other view's post-action navigation in this
      // codebase) — flushPromises() alone isn't enough to settle it, since
      // Vue Router's own navigation resolves over more than one microtask
      // tick. vi.waitFor retries until it actually lands.
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/playlists'))

      expect(deleteSpy).toHaveBeenCalledWith('p1')
      expect(dialog.visible).toBe(false)
    })

    it('keeps the dialog open and surfaces an error if the delete fails', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchPlaylist').mockResolvedValue(makePlaylist())
      const deleteSpy = vi
        .spyOn(library, 'deletePlaylist')
        .mockRejectedValue(new Error('network error'))
      const { wrapper, router } = await mountView()
      const dialog = await openDeleteDialog(wrapper)

      await dialog.confirm()

      expect(deleteSpy).toHaveBeenCalledWith('p1')
      // Stays put — a failed delete must not navigate away as if it worked.
      expect(dialog.visible).toBe(true)
      expect(router.currentRoute.value.path).toBe('/playlists/p1')
    })
  })

  describe('reordering songs', () => {
    const songs = [makeSong('a'), makeSong('b'), makeSong('c')]

    async function mountWithSongs() {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchPlaylist').mockResolvedValue(
        makePlaylist({ songs: [...songs], songCount: songs.length }),
      )
      const { wrapper } = await mountView()
      return {
        library,
        vm: wrapper.vm as unknown as {
          playlist: Playlist
          onReorder(move: { from: number; to: number }): Promise<void>
        },
      }
    }

    it('saves the whole new order, not just the song that moved', async () => {
      const { library, vm } = await mountWithSongs()
      const reorderSpy = vi.spyOn(library, 'reorderPlaylist').mockResolvedValue()

      await vm.onReorder({ from: 0, to: 2 })

      expect(reorderSpy).toHaveBeenCalledWith('p1', ['b', 'c', 'a'])
    })

    it('moves the row immediately rather than after the round trip', async () => {
      const { library, vm } = await mountWithSongs()
      let resolveSave: () => void = () => {}
      vi.spyOn(library, 'reorderPlaylist').mockReturnValue(
        new Promise<void>((resolve) => {
          resolveSave = resolve
        }),
      )

      const saving = vm.onReorder({ from: 2, to: 0 })
      // Still in flight — a drag that only takes effect once the server
      // answers reads as a drag that didn't take.
      expect(vm.playlist.songs.map((song) => song.id)).toEqual(['c', 'a', 'b'])

      resolveSave()
      await saving
      expect(vm.playlist.songs.map((song) => song.id)).toEqual(['c', 'a', 'b'])
    })

    it('puts the song back and says so when the save fails', async () => {
      const { library, vm } = await mountWithSongs()
      vi.spyOn(library, 'reorderPlaylist').mockRejectedValue(new Error('network error'))

      await vm.onReorder({ from: 0, to: 2 })

      expect(vm.playlist.songs.map((song) => song.id)).toEqual(['a', 'b', 'c'])
    })
  })

  describe('removing songs', () => {
    const songs = [makeSong('a'), makeSong('b'), makeSong('c')]

    /** The banner the page puts above the list, or null when there is
     * none. Not a toast: the offer to undo has to sit where the change it
     * undoes is visible, for as long as that page is open. */
    function banner(wrapper: Awaited<ReturnType<typeof mountView>>['wrapper']) {
      const notice = wrapper.findComponent(PlaylistNotice)
      return notice.exists() ? notice : null
    }

    /** The undo button inside it, picked by its label so the alert's own
     * close button can't be mistaken for it. */
    function undoButton(wrapper: Awaited<ReturnType<typeof mountView>>['wrapper']) {
      return banner(wrapper)
        ?.findAll('button')
        .find((button) => button.text() === i18n.global.t('common.undo'))
    }

    /** Mounts the page against a stand-in server whose track list the test
     * can change under it. fetchPlaylist builds a *fresh* playlist object
     * every call on purpose: handing back one shared object would carry
     * the page's own optimistic edit back in, and a re-read would then be
     * indistinguishable from no re-read at all. */
    async function mountAgainstServer(onServer: Song[] = [...songs]) {
      const server = { songs: onServer }
      const library = useLibraryStore()
      const fetchPlaylist = vi
        .spyOn(library, 'fetchPlaylist')
        // Keyed by id: a test that navigates to another playlist has to
        // get another playlist back, not this one under a new route.
        .mockImplementation(async (id: string) =>
          id === 'p1'
            ? makePlaylist({ songs: [...server.songs], songCount: server.songs.length })
            : makePlaylist({ id, songs: [makeSong('other')], songCount: 1 }),
        )
      const { wrapper, router } = await mountView()
      return {
        server,
        library,
        fetchPlaylist,
        wrapper,
        router,
        vm: wrapper.vm as unknown as {
          playlist: Playlist
          onRemove(removal: { indexes: number[]; songs: Song[] }): Promise<void>
        },
      }
    }

    it('takes the row off the list before the server has answered', async () => {
      const { library, vm } = await mountAgainstServer()
      let resolveRemove: () => void = () => {}
      vi.spyOn(library, 'removeFromPlaylist').mockReturnValue(
        new Promise<void>((resolve) => {
          resolveRemove = resolve
        }),
      )

      const removing = vm.onRemove({ indexes: [1], songs: [songs[1]!] })
      expect(vm.playlist.songs.map((song) => song.id)).toEqual(['a', 'c'])

      resolveRemove()
      await removing
    })

    it('moves the heading with the rows instead of a round trip later', async () => {
      // songCount and duration come from the server and are stale the
      // moment a row goes, so the heading counts the list it is above.
      const { library, vm, wrapper, server } = await mountAgainstServer()
      expect(wrapper.text()).toContain('3 songs')
      let resolveRemove: () => void = () => {}
      vi.spyOn(library, 'removeFromPlaylist').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveRemove = () => {
              server.songs = [songs[0]!, songs[2]!]
              resolve()
            }
          }),
      )

      const removing = vm.onRemove({ indexes: [1], songs: [songs[1]!] })
      await flushPromises()

      expect(wrapper.text()).toContain('2 songs')

      // Settled before the test ends: writes to one playlist run one after
      // another, so a request left hanging here would block every later
      // test in this file.
      resolveRemove()
      await removing
    })

    it('shows what the server actually has, not what was asked for', async () => {
      // A removal is not always granted as sent: both bridges drop a
      // position the playlist no longer holds without a word, and Jellyfin
      // 12 takes every copy of a song listed twice (see
      // docs/investigations/playlist-duplicate-entries.md). Whatever the
      // reason, the page must not go on showing its own guess.
      const { library, vm, server } = await mountAgainstServer()
      vi.spyOn(library, 'removeFromPlaylist').mockImplementation(async () => {
        // The server took 'c' along with the row that was named.
        server.songs = [songs[1]!]
      })

      await vm.onRemove({ indexes: [0], songs: [songs[0]!] })

      expect(vm.playlist.songs.map((song) => song.id)).toEqual(['b'])
    })

    it('re-fetches instead of restoring the old list when the removal fails', async () => {
      // Not a rollback: removing several entries is not one atomic request
      // on every backend (the Plex bridge deletes one at a time), so after
      // a failure only the server knows what is actually left.
      const { library, vm, wrapper, fetchPlaylist } = await mountAgainstServer()
      vi.spyOn(library, 'removeFromPlaylist').mockRejectedValue(new Error('network error'))
      const fetchesAfterMount = fetchPlaylist.mock.calls.length

      await vm.onRemove({ indexes: [0], songs: [songs[0]!] })

      expect(fetchPlaylist.mock.calls.length).toBe(fetchesAfterMount + 1)
      expect(banner(wrapper)?.props('notice').level).toBe('error')
    })

    it('offers an undo that sends the complete original list back', async () => {
      const { library, vm, wrapper, server } = await mountAgainstServer()
      vi.spyOn(library, 'removeFromPlaylist').mockImplementation(async () => {
        server.songs = [songs[0]!, songs[2]!]
      })
      const restore = vi.spyOn(library, 'restorePlaylistSongs').mockImplementation(async () => {
        server.songs = [...songs]
      })

      await vm.onRemove({ indexes: [1], songs: [songs[1]!] })
      expect(vm.playlist.songs.map((song) => song.id)).toEqual(['a', 'c'])

      await undoButton(wrapper)!.trigger('click')
      await flushPromises()

      // The whole list, not just the song that went — setPlaylistSongs
      // replaces the playlist's contents outright.
      expect(restore).toHaveBeenCalledWith('p1', ['a', 'b', 'c'])
      expect(vm.playlist.songs.map((song) => song.id)).toEqual(['a', 'b', 'c'])
      // And the offer goes with it: pressing it twice would send the same
      // list a second time.
      expect(banner(wrapper)).toBeNull()
    })

    it('says so instead of showing a headings row when the last track goes', async () => {
      // An empty playlist is a state the app already had (Subsonic and
      // Jellyfin can create one outright, see capabilities.ts) — removing
      // the only track is just the easy way to reach it.
      const { library, vm, wrapper, server } = await mountAgainstServer([songs[0]!])
      vi.spyOn(library, 'removeFromPlaylist').mockImplementation(async () => {
        server.songs = []
      })
      const restore = vi.spyOn(library, 'restorePlaylistSongs').mockImplementation(async () => {
        server.songs = [songs[0]!]
      })

      await vm.onRemove({ indexes: [0], songs: [songs[0]!] })

      expect(wrapper.text()).toContain(i18n.global.t('playlists.noSongsYet'))
      expect(wrapper.findComponent(SongTable).exists()).toBe(false)

      // And back out of it again: the servers all keep an emptied playlist
      // rather than deleting it, so the undo has something to restore into
      // (measured — see docs/investigations/playlist-duplicate-entries.md).
      await undoButton(wrapper)!.trigger('click')
      await flushPromises()

      expect(restore).toHaveBeenCalledWith('p1', ['a'])
      expect(wrapper.findComponent(SongTable).exists()).toBe(true)
    })

    it('can be put away without undoing anything', async () => {
      // A banner that stays until it is dismissed needs a way to dismiss
      // it that is not "undo".
      const { library, vm, wrapper, server } = await mountAgainstServer()
      vi.spyOn(library, 'removeFromPlaylist').mockImplementation(async () => {
        server.songs = [songs[0]!, songs[2]!]
      })
      const restore = vi.spyOn(library, 'restorePlaylistSongs').mockResolvedValue()

      await vm.onRemove({ indexes: [1], songs: [songs[1]!] })
      await banner(wrapper)!.find('.v-alert__close button').trigger('click')
      await flushPromises()

      expect(banner(wrapper)).toBeNull()
      expect(restore).not.toHaveBeenCalled()
      expect(vm.playlist.songs.map((song) => song.id)).toEqual(['a', 'c'])
    })

    it('does not carry the undo offer over to another playlist', async () => {
      // The banner lives in the page, so opening a different playlist takes
      // the offer with it. That is most of the reason it is not a toast:
      // one would still be floating there, over a list it no longer
      // describes, offering to change a playlist you have left.
      const { library, vm, wrapper, server, router } = await mountAgainstServer()
      vi.spyOn(library, 'removeFromPlaylist').mockImplementation(async () => {
        server.songs = [songs[0]!, songs[2]!]
      })

      await vm.onRemove({ indexes: [1], songs: [songs[1]!] })
      expect(undoButton(wrapper)).toBeDefined()

      await router.push('/playlists/p2')
      await flushPromises()

      expect(vm.playlist.id).toBe('p2')
      expect(banner(wrapper)).toBeNull()
    })

    it('leaves a playlist alone when the page moves on mid-removal', async () => {
      // The request outlives the page it was started on. What must not
      // happen is its answer landing in the playlist now on screen.
      const { library, vm, wrapper, router, fetchPlaylist } = await mountAgainstServer()
      let finishRemove: () => void = () => {}
      vi.spyOn(library, 'removeFromPlaylist').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishRemove = resolve
          }),
      )

      const removing = vm.onRemove({ indexes: [1], songs: [songs[1]!] })
      await router.push('/playlists/p2')
      await flushPromises()
      const fetchesAfterNavigation = fetchPlaylist.mock.calls.length

      finishRemove()
      await removing

      expect(vm.playlist.id).toBe('p2')
      expect(vm.playlist.songs.map((song) => song.id)).toEqual(['other'])
      expect(banner(wrapper)).toBeNull()
      // And no re-read of a page that is showing something else by now.
      expect(fetchPlaylist.mock.calls.length).toBe(fetchesAfterNavigation)
    })

    it('runs two removals one after another, and only re-reads at the end', async () => {
      // Both are addressed by position, so overlapping them would resolve
      // the second against a list the first is still changing.
      const { library, vm, server, fetchPlaylist } = await mountAgainstServer()
      const order: string[] = []
      let releaseFirst: () => void = () => {}
      const firstInFlight = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      let call = 0
      vi.spyOn(library, 'removeFromPlaylist').mockImplementation(async () => {
        const mine = ++call
        order.push(`start ${mine}`)
        if (mine === 1) await firstInFlight
        order.push(`done ${mine}`)
        server.songs = server.songs.slice(1)
      })
      const fetchesAfterMount = fetchPlaylist.mock.calls.length

      const first = vm.onRemove({ indexes: [0], songs: [songs[0]!] })
      const second = vm.onRemove({ indexes: [0], songs: [songs[1]!] })
      await flushPromises()
      releaseFirst()
      await Promise.all([first, second])

      expect(order).toEqual(['start 1', 'done 1', 'start 2', 'done 2'])
      // One re-read, by the write that was last in the queue.
      expect(fetchPlaylist.mock.calls.length).toBe(fetchesAfterMount + 1)
      expect(vm.playlist.songs.map((song) => song.id)).toEqual(['c'])
    })
  })
})
