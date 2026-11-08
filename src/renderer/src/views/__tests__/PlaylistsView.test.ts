import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import PlaylistsView from '../PlaylistsView.vue'
import type { Playlist } from '@/types/library'

const vuetify = createVuetify({ components, directives })

function makePlaylist(id: string, overrides: Partial<Playlist> = {}): Playlist {
  return {
    id,
    name: `List ${id}`,
    songCount: 2,
    duration: 400,
    coverArtId: null,
    public: false,
    owner: 'me',
    changed: null,
    readonly: false,
    smart: false,
    songs: [],
    ...overrides,
  }
}

async function mountView(playlists: Playlist[]) {
  const library = useLibraryStore()
  library.playlists = playlists
  vi.spyOn(library, 'fetchPlaylists').mockResolvedValue()
  useAuthStore().username = 'me'
  const wrapper = mount(PlaylistsView, {
    global: {
      plugins: [vuetify, i18n],
      stubs: {
        // The header's own look is not under test; its action buttons are.
        DetailHeader: { template: '<div><slot name="actions" /></div>' },
        StickyFilter: { template: '<div><slot /></div>' },
        PlaylistCard: true,
        PlaylistBuilderDialog: true,
        PlaylistEditDialog: true,
        PlaylistDeleteDialog: true,
      },
    },
  })
  await flushPromises()
  return wrapper
}

describe('PlaylistsView', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('offers a new smart playlist only on Navidrome', async () => {
    const label = i18n.global.t('smartPlaylists.newButton')
    const plain = await mountView([])
    expect(plain.findAll('.v-btn').some((button) => button.text() === label)).toBe(false)

    setActivePinia(createPinia())
    useAuthStore().health = {
      ffmpeg: true,
      navidrome_configured: true,
      server_lock: null,
      session_server_type: 'subsonic',
      session_server_software: 'navidrome',
    }
    const navidrome = await mountView([])
    expect(navidrome.findAll('.v-btn').some((button) => button.text() === label)).toBe(true)
  })

  it('files Jellyfin and Plex playlists by what the bridge says, not by owner name', async () => {
    const wrapper = await mountView([
      makePlaylist('mine'),
      makePlaylist('anna', { owner: 'anna' }),
      makePlaylist('plex', { owner: '', ownedByUser: true }),
      makePlaylist('shared', { owner: '', ownedByUser: false }),
    ])
    const vm = wrapper.vm as unknown as {
      personalPlaylists: Playlist[]
      globalPlaylists: Playlist[]
    }

    expect(vm.personalPlaylists.map((playlist) => playlist.id)).toEqual(['mine', 'plex'])
    expect(vm.globalPlaylists.map((playlist) => playlist.id)).toEqual(['anna', 'shared'])
  })

  type View = {
    personalPlaylists: Playlist[]
    globalPlaylists: Playlist[]
    segments: { value: string }[]
    activeSegment: string
    segment: string
    pickSort: (key: string) => void
    toggleDirection: () => void
    setListView: (list: boolean) => void
    listView: boolean
  }
  const ids = (playlists: Playlist[]) => playlists.map((playlist) => playlist.id)

  it('offers no groups when every playlist is the plain, own kind', async () => {
    const wrapper = await mountView([makePlaylist('a'), makePlaylist('b')])

    expect((wrapper.vm as unknown as View).segments).toEqual([])
  })

  it('narrows both sections to the picked group', async () => {
    const wrapper = await mountView([
      makePlaylist('plain'),
      makePlaylist('rules', { smart: true }),
      makePlaylist('anna', { owner: 'anna' }),
    ])
    const vm = wrapper.vm as unknown as View

    vm.segment = 'smart'
    await flushPromises()
    expect(ids(vm.personalPlaylists)).toEqual(['rules'])
    expect(ids(vm.globalPlaylists)).toEqual([])

    vm.segment = 'shared'
    await flushPromises()
    expect(ids(vm.personalPlaylists)).toEqual([])
    expect(ids(vm.globalPlaylists)).toEqual(['anna'])
  })

  it('goes back to everything when the picked group has emptied', async () => {
    const wrapper = await mountView([makePlaylist('plain'), makePlaylist('r', { smart: true })])
    const vm = wrapper.vm as unknown as View
    vm.segment = 'smart'
    await flushPromises()

    useLibraryStore().playlists = [makePlaylist('plain')]
    await flushPromises()

    expect(vm.activeSegment).toBe('all')
    expect(ids(vm.personalPlaylists)).toEqual(['plain'])
  })

  it('applies the picked order and remembers it for the next visit', async () => {
    const playlists = [makePlaylist('b', { name: 'B' }), makePlaylist('a', { name: 'A' })]
    const first = (await mountView(playlists)).vm as unknown as View

    first.pickSort('name')
    await flushPromises()
    expect(ids(first.personalPlaylists)).toEqual(['a', 'b'])

    first.toggleDirection()
    await flushPromises()
    expect(ids(first.personalPlaylists)).toEqual(['b', 'a'])

    const second = (await mountView(playlists)).vm as unknown as View
    expect(ids(second.personalPlaylists)).toEqual(['b', 'a'])
  })

  it('remembers grid or list for the next visit', async () => {
    const first = (await mountView([makePlaylist('a')])).vm as unknown as View
    expect(first.listView).toBe(false)

    first.setListView(true)

    expect(((await mountView([makePlaylist('a')])).vm as unknown as View).listView).toBe(true)
  })
})
