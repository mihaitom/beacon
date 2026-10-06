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
import { usePlaybackStore } from '@/stores/playback'
import PlaylistsView from '../PlaylistsView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
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
        DetailHeader: true,
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

  it('plays a playlist shuffled from its shuffle button', async () => {
    const songs = [makeSong('1'), makeSong('2')]
    const wrapper = await mountView([makePlaylist('a')])
    vi.spyOn(useLibraryStore(), 'fetchPlaylist').mockResolvedValue(makePlaylist('a', { songs }))
    const playback = usePlaybackStore()
    const play = vi.spyOn(playback, 'playSongList').mockResolvedValue()

    wrapper.findComponent({ name: 'PlaylistRow' }).vm.$emit('shuffle', makePlaylist('a'))
    await flushPromises()

    expect(playback.shuffle).toBe(true)
    expect(play).toHaveBeenCalledWith(songs, 0, false, true)
  })
})
