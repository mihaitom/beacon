import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import { createMemoryHistory, createRouter } from 'vue-router'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import MobileLibraryView, { resetFavoritesFilter } from '../MobileLibraryView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
})

function mountView() {
  return mount(MobileLibraryView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { CoverArt: true, MobileSongActionSheet: true },
    },
  })
}

function stubStore() {
  const library = useLibraryStore()
  vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
  vi.spyOn(library, 'fetchAlbums').mockResolvedValue()
  vi.spyOn(library, 'fetchArtists').mockResolvedValue()
  vi.spyOn(library, 'fetchStarred').mockResolvedValue()
  library.allSongs = [
    makeSong('a', { title: 'Everything A' }),
    makeSong('b', { title: 'Everything B' }),
  ]
  library.starred = {
    songs: [makeSong('f1', { title: 'Loved One' }), makeSong('f2', { title: 'Loved Two' })],
    albums: [],
    artists: [],
  }
  return library
}

const heart = (wrapper: ReturnType<typeof mountView>) => wrapper.find('.mobile-library__favorites')
const titles = (wrapper: ReturnType<typeof mountView>) =>
  wrapper.findAllComponents({ name: 'MobileSongRow' }).map((row) => row.text())

/** Favourites are the library's heart filter on a phone rather than a tab
 * of their own. */
describe('MobileLibraryView favourites filter', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    resetFavoritesFilter()
    useAuthStore().capabilities.favorites = true
    await router.replace('/')
  })

  it('narrows the list to the favourites and back', async () => {
    const library = stubStore()
    const wrapper = mountView()
    await flushPromises()

    await heart(wrapper).trigger('click')
    await flushPromises()
    expect(library.fetchStarred).toHaveBeenCalled()
    expect(titles(wrapper).join()).toContain('Loved One')
    expect(titles(wrapper).join()).not.toContain('Everything A')

    await heart(wrapper).trigger('click')
    await flushPromises()
    expect(titles(wrapper).join()).toContain('Everything A')
  })

  it('searches within the favourites', async () => {
    stubStore()
    const wrapper = mountView()
    await flushPromises()
    await heart(wrapper).trigger('click')

    vi.useFakeTimers()
    await wrapper.find('input').setValue('two')
    vi.advanceTimersByTime(300)
    vi.useRealTimers()
    await flushPromises()

    expect(titles(wrapper)).toHaveLength(1)
    expect(titles(wrapper)[0]).toContain('Loved Two')
  })

  /** The tab bar opens the library at its bare address. */
  it('is still on when the library is opened again', async () => {
    stubStore()
    const first = mountView()
    await flushPromises()
    await heart(first).trigger('click')
    first.unmount()
    await router.replace('/m/library')

    const again = mountView()
    await flushPromises()
    expect(titles(again).join()).toContain('Loved One')
  })

  it('opens filtered from an old favourites link', async () => {
    stubStore()
    await router.replace('/m/library?favorites=1')
    const wrapper = mountView()
    await flushPromises()

    expect(titles(wrapper).join()).toContain('Loved One')
  })

  /** The filter's own bookkeeping runs before the view has read where it
   * arrived; it must not write the address over first. */
  it('keeps the half it was opened on', async () => {
    const library = stubStore()
    library.albums = [{ id: 'al1', name: 'An Album', artist: 'X' } as never]
    await router.replace('/m/library?tab=albums')
    mountView()
    await flushPromises()

    expect(router.currentRoute.value.query.tab).toBe('albums')
  })

  it('writes itself into the address, so coming back from an album keeps it', async () => {
    stubStore()
    const wrapper = mountView()
    await flushPromises()
    await heart(wrapper).trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query.favorites).toBe('1')
  })

  /** A collection somebody put together plays on, as on the desktop's
   * Favourites page; the whole library plays only the song tapped. */
  it('plays on after a tapped favourite', async () => {
    stubStore()
    const playback = usePlaybackStore()
    const play = vi.spyOn(playback, 'playSongList').mockResolvedValue()
    const wrapper = mountView()
    await flushPromises()
    await heart(wrapper).trigger('click')
    await flushPromises()

    await wrapper.findAllComponents({ name: 'MobileSongRow' })[1]!.trigger('click')

    const [songs, index] = play.mock.calls[0]!
    expect(songs.map((s) => s.id)).toEqual(['f1', 'f2'])
    expect(index).toBe(1)
  })

  it('says how to fill an empty favourites list', async () => {
    const library = stubStore()
    library.starred = { songs: [], albums: [], artists: [] }
    const wrapper = mountView()
    await flushPromises()
    await heart(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain(i18n.global.t('favorites.noSongsYet'))
  })

  it('offers no heart on a server without favourites, and drops one left on', async () => {
    stubStore()
    const first = mountView()
    await flushPromises()
    await heart(first).trigger('click')
    first.unmount()
    await router.replace('/m/library')

    useAuthStore().capabilities.favorites = false
    const wrapper = mountView()
    await flushPromises()

    expect(heart(wrapper).exists()).toBe(false)
    expect(titles(wrapper).join()).toContain('Everything A')
  })
})
