// The phone's playlist page. Its own share of the removal work is
// knowing *which* entry the action sheet was opened on — the sheet itself
// only ever sees a song, and a playlist can hold the same song twice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import MobilePlaylistDetailView from '../MobilePlaylistDetailView.vue'
import MobileSongActionSheet from '@/components/mobile/MobileSongActionSheet.vue'
import PlaylistNotice from '@/components/library/PlaylistNotice.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Playlist, Song } from '@/types/library'

const vuetify = createVuetify({ components, directives })

const OWNER = 'thomas'

function makePlaylist(songs: Song[], overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: 'p1',
    name: 'My mix',
    songCount: songs.length,
    duration: 600,
    coverArtId: null,
    public: false,
    owner: OWNER,
    songs,
    ...overrides,
  }
}

function mountView() {
  return mount(MobilePlaylistDetailView, {
    global: {
      plugins: [vuetify, i18n],
      stubs: { CoverArt: true },
      mocks: { $route: { params: { id: 'p1' } }, $emitter: emitter },
    },
  })
}

/** Mounts the page against a stand-in server whose track list the test can
 * change under it. fetchPlaylist builds a fresh playlist every call on
 * purpose — see the desktop page's own test for why one shared object
 * would make a re-read untestable. */
async function mountAgainstServer(
  songs: Song[] = [makeSong('a'), makeSong('dup'), makeSong('dup')],
  playlistOverrides: Partial<Playlist> = {},
) {
  const server = { songs }
  const library = useLibraryStore()
  const fetchPlaylist = vi
    .spyOn(library, 'fetchPlaylist')
    .mockImplementation(async () => makePlaylist([...server.songs], playlistOverrides))
  const wrapper = mountView()
  mounted.push(wrapper)
  await flushPromises()
  return { server, library, fetchPlaylist, wrapper }
}

/** Opens the sheet on a row and picks "Remove from playlist" — the whole
 * path the reader takes, since the index only gets recorded on the way in. */
async function removeRow(wrapper: ReturnType<typeof mountView>, index: number) {
  const rows = wrapper.findAllComponents({ name: 'MobileSongRow' })
  rows[index]!.vm.$emit('open-actions')
  await flushPromises()
  wrapper.findComponent(MobileSongActionSheet).vm.$emit('remove')
  await flushPromises()
}

const mounted: ReturnType<typeof mountView>[] = []

function rowCount(wrapper: ReturnType<typeof mountView>) {
  return wrapper.findAllComponents({ name: 'MobileSongRow' }).length
}

/** The banner above the list, or null — see the desktop page's own test
 * for why the outcome of a removal is not a toast. */
function banner(wrapper: ReturnType<typeof mountView>) {
  const notice = wrapper.findComponent(PlaylistNotice)
  return notice.exists() ? notice : null
}

/** Its undo button, by label, so the alert's close button isn't mistaken
 * for it. */
function undoButton(wrapper: ReturnType<typeof mountView>) {
  return banner(wrapper)
    ?.findAll('button')
    .find((button) => button.text() === i18n.global.t('common.undo'))
}

describe('MobilePlaylistDetailView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().username = OWNER
    // Opening the sheet warms its playlist picker, which unmocked is a
    // real request to a connect that isn't running.
    vi.spyOn(useLibraryStore(), 'fetchPlaylists').mockResolvedValue()
  })

  afterEach(() => {
    emitter.all.clear()
    // The sheet teleports into document.body, so an unmounted page would
    // otherwise leave its menu entries behind for the next test to find.
    while (mounted.length) mounted.pop()?.unmount()
  })

  it('removes the entry the sheet was opened on, not the first with that id', async () => {
    const { library, wrapper, server } = await mountAgainstServer()
    const remove = vi.spyOn(library, 'removeFromPlaylist').mockImplementation(async () => {
      server.songs = server.songs.slice(0, 2)
    })

    await removeRow(wrapper, 2)

    expect(remove).toHaveBeenCalledWith('p1', [2])
    expect(rowCount(wrapper)).toBe(2)
  })

  it('offers the same undo the desktop page does', async () => {
    const { library, wrapper, server } = await mountAgainstServer()
    const before = [...server.songs]
    vi.spyOn(library, 'removeFromPlaylist').mockImplementation(async () => {
      server.songs = server.songs.slice(1)
    })
    const restore = vi.spyOn(library, 'restorePlaylistSongs').mockImplementation(async () => {
      server.songs = before
    })

    await removeRow(wrapper, 0)
    expect(rowCount(wrapper)).toBe(2)

    await undoButton(wrapper)!.trigger('click')
    await flushPromises()

    expect(restore).toHaveBeenCalledWith('p1', ['a', 'dup', 'dup'])
    expect(rowCount(wrapper)).toBe(3)
    expect(banner(wrapper)).toBeNull()
  })

  it('re-fetches rather than guessing when the removal fails', async () => {
    const { library, wrapper, fetchPlaylist } = await mountAgainstServer()
    vi.spyOn(library, 'removeFromPlaylist').mockRejectedValue(new Error('network error'))
    const fetchesAfterMount = fetchPlaylist.mock.calls.length

    await removeRow(wrapper, 1)

    expect(fetchPlaylist.mock.calls.length).toBe(fetchesAfterMount + 1)
    expect(banner(wrapper)?.props('notice').level).toBe('error')
  })

  it('shows what the server actually has, not what was asked for', async () => {
    // Jellyfin 12 cannot tell two copies of one song apart and takes both
    // (docs/investigations/playlist-duplicate-entries.md) — precisely the
    // playlist this page is mounted on here.
    const { library, wrapper, server } = await mountAgainstServer()
    vi.spyOn(library, 'removeFromPlaylist').mockImplementation(async () => {
      server.songs = [server.songs[0]!]
    })

    await removeRow(wrapper, 1)

    expect(rowCount(wrapper)).toBe(1)
  })

  it('counts the rows it is showing, not the count the server sent', async () => {
    // Asserted while the request is still out, which is the only window
    // the two can disagree in: once the re-read lands, the server's own
    // songCount is right again either way.
    const { library, wrapper, server } = await mountAgainstServer()
    expect(wrapper.text()).toContain('3 songs')
    let finishRemove: () => void = () => {}
    vi.spyOn(library, 'removeFromPlaylist').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRemove = () => {
            server.songs = server.songs.slice(1)
            resolve()
          }
        }),
    )

    await removeRow(wrapper, 0)

    expect(wrapper.text()).toContain('2 songs')

    // Settled before the test ends: writes to one playlist run one after
    // another, so a request left hanging would block every later test.
    finishRemove()
    await flushPromises()
  })

  it('says so instead of showing an empty list when the last track goes', async () => {
    const { library, wrapper, server } = await mountAgainstServer([makeSong('only')])
    vi.spyOn(library, 'removeFromPlaylist').mockImplementation(async () => {
      server.songs = []
    })

    await removeRow(wrapper, 0)

    expect(rowCount(wrapper)).toBe(0)
    expect(wrapper.text()).toContain(i18n.global.t('playlists.noSongsYet'))
  })

  it('leaves a playlist alone when the page has moved on', async () => {
    // The guard behind both halves of a removal — see the desktop page's
    // own tests, which drive it through a real route change. Here the page
    // is simply pointed at another playlist while the request is out.
    const { library, wrapper } = await mountAgainstServer()
    let finishRemove: () => void = () => {}
    vi.spyOn(library, 'removeFromPlaylist').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRemove = resolve
        }),
    )

    await removeRow(wrapper, 0)
    const vm = wrapper.vm as unknown as { playlist: Playlist }
    vm.playlist = makePlaylist([makeSong('other')], { id: 'p2' })
    await flushPromises()

    finishRemove()
    await flushPromises()

    expect(vm.playlist.songs.map((song) => song.id)).toEqual(['other'])
    expect(banner(wrapper)).toBeNull()
  })

  it('offers the entry on your own playlist and not on somebody else’s', async () => {
    // The desktop page gates its table the same way: a shared playlist
    // belongs to whoever made it and the server refuses the write, so the
    // entry would only ever produce an error toast.
    const songs = [makeSong('a'), makeSong('b')]
    const own = await mountAgainstServer(songs)
    expect(own.wrapper.findComponent(MobileSongActionSheet).props('removable')).toBe(true)

    const theirs = await mountAgainstServer(songs, { owner: 'someone-else' })
    expect(theirs.wrapper.findComponent(MobileSongActionSheet).props('removable')).toBe(false)
  })
})
