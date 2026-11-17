// The shelves' data and loading are the desktop Home's (homeShelvesMixin,
// covered through HomeView's own tests); what is checked here is what the
// phone layout does with a tap.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import MobileHomeView from '../MobileHomeView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Album, Song } from '@/types/library'

const vuetify = createVuetify({ components, directives })

function album(id: string): Album {
  return { id, name: `Album ${id}`, artist: 'Someone', coverArtId: null } as Album
}

async function mountHome({ recent = [] as Album[], topSongs = [] as Song[] } = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.push('/m/home')
  await router.isReady()
  const library = useLibraryStore()
  vi.spyOn(library, 'fetchFrequentAlbums').mockResolvedValue([])
  vi.spyOn(library, 'fetchRecentlyPlayedAlbums').mockResolvedValue(recent)
  vi.spyOn(library, 'fetchRandomAlbums').mockResolvedValue([])
  vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
  vi.spyOn(library, 'fetchRediscoverSongs').mockResolvedValue([])
  vi.spyOn(library, 'fetchArtists').mockResolvedValue()
  vi.spyOn(library, 'client').mockReturnValue({
    getAlbumList2: vi.fn().mockResolvedValue([]),
    coverArtUrl: () => null,
  } as unknown as ReturnType<typeof library.client>)
  library.allSongs = topSongs
  vi.spyOn(library, 'mostPlayedSongs', 'get').mockReturnValue(topSongs)
  const wrapper = mount(MobileHomeView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { CoverArt: true, MobileSongActionSheet: true },
      mocks: { $emitter: emitter },
    },
  })
  await flushPromises()
  return { wrapper, router, library }
}

describe('MobileHomeView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /** Variant A of the design: the cover is the play target, the name
   * opens the album. */
  it('plays a recent album from its cover and opens it from its name', async () => {
    // The first recent album is the hero's while nothing plays.
    const { wrapper, library } = await mountHome({ recent: [album('hero'), album('2')] })
    const songs = [makeSong('s1'), makeSong('s2')]
    vi.spyOn(library, 'fetchAlbum').mockResolvedValue({ ...album('2'), songs } as Album)
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()

    const tile = wrapper.findComponent({ name: 'MobileAlbumTile' })
    await tile.find('button').trigger('click')
    await flushPromises()

    expect(library.fetchAlbum).toHaveBeenCalledWith('2')
    expect(play.mock.calls[0]![0]).toEqual(songs)
    expect(tile.find('a').attributes('href')).toBe('/m/albums/2')
  })

  it('plays the most played songs on from the one tapped', async () => {
    const top = [makeSong('t1'), makeSong('t2'), makeSong('t3')]
    const { wrapper } = await mountHome({ topSongs: top })
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()

    await wrapper.findAllComponents({ name: 'MobileSongRow' })[1]!.trigger('click')

    expect(play).toHaveBeenCalledWith(top, 1)
  })

  it('opens a long song list from its heading and closes it again', async () => {
    const top = Array.from({ length: 12 }, (_, i) => makeSong(`t${i}`))
    const { wrapper } = await mountHome({ topSongs: top })
    const rows = () => wrapper.findAllComponents({ name: 'MobileSongRow' }).length
    const collapsed = rows()
    expect(collapsed).toBeLessThan(top.length)

    await wrapper.find('.mobile-home__expand').trigger('click')
    expect(rows()).toBe(top.length)

    await wrapper.find('.mobile-home__expand').trigger('click')
    expect(rows()).toBe(collapsed)
  })

  it('plays the whole list from "play all", not just the rows showing', async () => {
    const top = Array.from({ length: 12 }, (_, i) => makeSong(`t${i}`))
    const { wrapper } = await mountHome({ topSongs: top })
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()

    await wrapper.find(`[aria-label="${i18n.global.t('home.playAll')}"]`).trigger('click')

    expect(play.mock.calls[0]![0]).toEqual(top)
  })

  it('starts the most recent album from the hero while nothing plays', async () => {
    const { wrapper, library } = await mountHome({ recent: [album('last')] })
    const songs = [makeSong('s1')]
    vi.spyOn(library, 'fetchAlbum').mockResolvedValue({ ...album('last'), songs } as Album)
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()

    await wrapper.find('.mobile-home-hero .v-btn').trigger('click')
    await flushPromises()

    expect(library.fetchAlbum).toHaveBeenCalledWith('last')
    expect(play.mock.calls[0]![0]).toEqual(songs)
  })

  /** Not the desktop's /now-playing, which would open the desktop page
   * inside the phone shell. */
  it("leads from the hero's cover to the phone's Now Playing while a song plays", async () => {
    const { wrapper, router } = await mountHome()
    usePlaybackStore().setQueue([makeSong('now')], 0)
    await flushPromises()

    await wrapper.find('.mobile-home-hero__cover').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/m/now-playing')
  })

  it('invites a first play when there is nothing to show yet', async () => {
    const { wrapper } = await mountHome()

    expect(wrapper.text()).toContain(i18n.global.t('home.readyToPlay'))
  })
})
