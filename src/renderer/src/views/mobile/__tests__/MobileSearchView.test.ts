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
import MobileSearchView from '../MobileSearchView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Album, Artist, Playlist, RadioStation } from '@/types/library'

const vuetify = createVuetify({ components, directives })
const page = { template: '<div />' }
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/m/search', name: 'm-search', component: page },
    { path: '/m/library', name: 'm-library', component: page },
    { path: '/:pathMatch(.*)*', component: page },
  ],
})

function stubLibrary() {
  const library = useLibraryStore()
  for (const action of [
    'fetchAllSongs',
    'fetchAlbums',
    'fetchArtists',
    'fetchPlaylists',
    'fetchRadioStations',
  ] as const) {
    vi.spyOn(library, action).mockResolvedValue()
  }
  library.allSongs = [makeSong('s1', { title: 'Blue Monday' }), makeSong('s2', { title: 'Red' })]
  library.albums = [{ id: 'al1', name: 'Blue Lines', artist: 'Massive' } as Album]
  library.artists = [{ id: 'ar1', name: 'Blue Oyster', albumCount: 2 } as Artist]
  library.playlists = [{ id: 'p1', name: 'Blue Hour', songCount: 3, duration: 600 } as Playlist]
  library.radioStations = [{ id: 'r1', name: 'Blue FM', streamUrl: 'http://x' } as RadioStation]
  return library
}

async function mountAt(q: string | null) {
  await router.replace(q === null ? '/m/search' : { path: '/m/search', query: { q } })
  const wrapper = mount(MobileSearchView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { CoverArt: true, MobileSongActionSheet: true, TileContextMenu: true },
    },
  })
  await flushPromises()
  return wrapper
}

describe('MobileSearchView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('finds every kind at once', async () => {
    stubLibrary()
    const wrapper = await mountAt('blue')

    for (const row of [
      'MobileArtistRow',
      'MobileAlbumRow',
      'MobileSongRow',
      'MobilePlaylistRow',
      'MobileRadioRow',
    ]) {
      expect(wrapper.findAllComponents({ name: row }), row).toHaveLength(1)
    }
  })

  it('says what it searches before anything is typed', async () => {
    stubLibrary()
    const wrapper = await mountAt(null)

    expect(wrapper.text()).toContain(i18n.global.t('search.everythingHint'))
    expect(wrapper.findAllComponents({ name: 'MobileSongRow' })).toHaveLength(0)
  })

  it('says so when nothing matches', async () => {
    stubLibrary()
    const wrapper = await mountAt('zzz')

    expect(wrapper.text()).toContain(i18n.global.t('search.noResults', { query: 'zzz' }))
  })

  it("opens a kind's every match from its show-all, as a step back from", async () => {
    const library = stubLibrary()
    library.albums = Array.from(
      { length: 6 },
      (_, i) => ({ id: `al${i}`, name: `Blue ${i}` }) as Album,
    )
    const wrapper = await mountAt('blue')

    const showAll = wrapper.findAll('button').find((b) => b.text().includes('6'))!
    await showAll.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({ q: 'blue', kind: 'albums' })
    expect(wrapper.findAllComponents({ name: 'MobileAlbumRow' })).toHaveLength(6)
    expect(wrapper.findAllComponents({ name: 'MobileSongRow' })).toHaveLength(0)

    router.back()
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ q: 'blue' })
    expect(wrapper.findAllComponents({ name: 'MobileAlbumRow' })).toHaveLength(4)
  })

  it('plays a matching song on its own', async () => {
    const library = stubLibrary()
    const playSongList = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const wrapper = await mountAt('blue')

    await wrapper.get('.mobile-song-row').trigger('click')
    await flushPromises()

    expect(playSongList).toHaveBeenCalledWith([library.allSongs[0]], 0)
  })
})
