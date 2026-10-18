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
import MobileFavoritesView from '../MobileFavoritesView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Album, Artist, Song } from '@/types/library'

const vuetify = createVuetify({ components, directives })

// MobileAlbumRow is a router-link; see MobileLibraryView.test.ts.
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
})

function stubFavorites(songs: Song[], albums: Album[] = [], artists: Artist[] = []) {
  const library = useLibraryStore()
  vi.spyOn(library, 'fetchStarred').mockImplementation(async () => {
    library.starred = { artists, albums, songs }
  })
  return library
}

function mountView() {
  return mount(MobileFavoritesView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { CoverArt: true, MobileSongActionSheet: true },
    },
  })
}

async function switchTo(wrapper: ReturnType<typeof mountView>, label: string) {
  const button = wrapper.findAll('.segmented__option').find((b) => b.text() === label)!
  await button.trigger('click')
  await flushPromises()
}

describe('MobileFavoritesView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('plays the favourites on from the tapped song', async () => {
    const songs = [makeSong('a'), makeSong('b'), makeSong('c')]
    stubFavorites(songs)
    const playSongList = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const wrapper = mountView()
    await flushPromises()

    await wrapper.findAllComponents({ name: 'MobileSongRow' })[1]!.vm.$emit('play')

    expect(playSongList).toHaveBeenCalledWith(songs, 1, true, true)
  })

  it('shows the albums half, and says when it is empty', async () => {
    stubFavorites([makeSong('a')])
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('.v-empty-state').exists()).toBe(false)

    await switchTo(wrapper, 'Albums')

    expect(wrapper.findAllComponents({ name: 'MobileSongRow' })).toHaveLength(0)
    expect(wrapper.find('.v-empty-state__title').text()).toBe(
      i18n.global.t('favorites.noAlbumsYet'),
    )
  })

  it('lists the favourite artists, each leading to its page', async () => {
    stubFavorites([], [], [{ id: 'ar1', name: 'Blue Band', albumCount: 2 } as Artist])
    const wrapper = mountView()
    await flushPromises()

    await switchTo(wrapper, 'Artists')

    expect(wrapper.get('.mobile-artist-row').attributes('href')).toBe('/m/artists/ar1')
  })
})
