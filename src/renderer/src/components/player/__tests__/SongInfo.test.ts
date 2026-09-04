import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import SongInfo from '../SongInfo.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/now-playing', component: { template: '<div />' } },
      { path: '/artists/:id', component: { template: '<div />' } },
    ],
  })
}

async function mountInfo() {
  const router = makeRouter()
  await router.push('/')
  await router.isReady()
  const wrapper = mount(SongInfo, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { CoverArt: true },
    },
  })
  return { wrapper, router }
}

describe('SongInfo', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows the placeholder and does not navigate to /now-playing when clicked with nothing playing', async () => {
    const { wrapper, router } = await mountInfo()
    const push = vi.spyOn(router, 'push')

    expect(wrapper.text()).toContain('Nothing playing')
    await wrapper.get('.song-info').trigger('click')

    expect(push).not.toHaveBeenCalled()
  })

  describe('a song is playing', () => {
    async function mountWithSong() {
      const mounted = await mountInfo()
      usePlaybackStore().setQueue([makeSong('a', { title: 'Track A', artist: 'Artist A' })], 0)
      await mounted.wrapper.vm.$nextTick()
      return mounted
    }

    it('renders the title and an artist link', async () => {
      const { wrapper } = await mountWithSong()

      expect(wrapper.text()).toContain('Track A')
      const artistLink = wrapper.get('.artist-link')
      expect(artistLink.text()).toBe('Artist A')
      expect(artistLink.attributes('href')).toBe('/artists/artist-1')
    })

    it('navigates to /now-playing when clicked', async () => {
      const { wrapper, router } = await mountWithSong()

      await wrapper.get('.song-info').trigger('click')
      // $router.push() isn't awaited by the click handler itself — give
      // the router's own async navigation a tick to actually land.
      await flushPromises()

      expect(router.currentRoute.value.path).toBe('/now-playing')
    })

    it('star button toggles the current song via the library store', async () => {
      const { wrapper } = await mountWithSong()
      const toggleStarSpy = vi.spyOn(useLibraryStore(), 'toggleStar').mockResolvedValue()
      const heartBtn = wrapper.get('.mdi-heart-outline').element.closest('button')!

      heartBtn.dispatchEvent(new Event('click', { bubbles: true }))
      // toggleStar() is async and flips song.starred only after the
      // (mocked) library-store round-trip resolves.
      await flushPromises()

      expect(toggleStarSpy).toHaveBeenCalledWith({ id: 'a', starred: false })
      expect(wrapper.find('.mdi-heart').exists()).toBe(true)
    })

    it('hides the star button when the server has no favorites capability', async () => {
      const { wrapper } = await mountWithSong()
      useAuthStore().serverType = 'plex'
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.mdi-heart-outline').exists()).toBe(false)
    })
  })

  describe('a radio station is playing', () => {
    it("shows the station's own now-playing tag as the title, station name as the second line", async () => {
      const { wrapper } = await mountInfo()
      usePlaybackStore().radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      usePlaybackStore().radioNowPlaying = 'Artist - Track'
      await wrapper.vm.$nextTick()

      expect(wrapper.get('.text-body-medium').text()).toBe('Artist - Track')
      expect(wrapper.get('.text-body-small').text()).toBe('Chill FM')
    })

    it('still shows a favicon for a station played without a homepage, via its Radio Browser hint', async () => {
      const { wrapper } = await mountInfo()
      usePlaybackStore().radioStation = {
        id: 'uuid-1',
        name: 'Example FM',
        streamUrl: 'http://example.com/stream',
        homePageUrl: null,
        favicon: 'https://cdn.example/icon.png',
      }
      await wrapper.vm.$nextTick()

      const coverArt = wrapper.findComponent({ name: 'CoverArt' })
      expect(coverArt.props('radioFavicon')).toEqual({
        homePageUrl: '',
        hint: 'https://cdn.example/icon.png',
        minSize: 512,
      })
    })
  })
})
