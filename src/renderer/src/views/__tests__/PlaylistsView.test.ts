import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import { useLastfmStore } from '@/stores/lastfm'
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
  vi.spyOn(useLastfmStore(), 'checkConfigured').mockResolvedValue(false)
  useAuthStore().username = 'me'
  const wrapper = mount(PlaylistsView, {
    global: {
      plugins: [vuetify, i18n],
      stubs: {
        // The header's own look is not under test; its action buttons are.
        DetailHeader: { template: '<div><slot name="actions" /></div>' },
        StickyFilter: { template: '<div><slot /></div>' },
        PlaylistRow: true,
        LastfmPlaylistDialog: true,
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
})
