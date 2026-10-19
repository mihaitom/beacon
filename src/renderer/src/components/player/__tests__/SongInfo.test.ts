import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import SongInfo from '../SongInfo.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import { useRadioMetadataStore } from '@/stores/radioMetadata'

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

  it('does not offer a click cursor with nothing playing, where a click does nothing', async () => {
    const { wrapper } = await mountInfo()

    expect(wrapper.get('.song-info').classes()).not.toContain('song-info--clickable')
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

      // $router.push() isn't awaited by the click handler, and the menu's
      // overlay holds every navigation for a timer (Vuetify's back-button
      // guard), so no fixed number of ticks lands it.
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/now-playing'))
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
  })

  describe('its menu', () => {
    async function openMenuForSong() {
      const mounted = await mountInfo()
      const song = makeSong('a', { title: 'Track A', rating: 2 })
      usePlaybackStore().setQueue([song], 0)
      await mounted.wrapper.vm.$nextTick()
      // Opening the menu warms up the playlist list for its submenu.
      vi.spyOn(useLibraryStore(), 'fetchPlaylists').mockResolvedValue()
      await mounted.wrapper.get('.song-info__more').trigger('click')
      await flushPromises()
      return { ...mounted, song: usePlaybackStore().currentSong! }
    }

    it('rates the playing song from its stars', async () => {
      const { wrapper, song } = await openMenuForSong()
      const setRating = vi.spyOn(useLibraryStore(), 'setRating').mockResolvedValue()

      wrapper.findComponent({ name: 'VRating' }).vm.$emit('update:modelValue', 4)
      await flushPromises()

      expect(setRating).toHaveBeenCalledWith('a', 4)
      expect(song.rating).toBe(4)
    })

    it('leaves the right-click alone with nothing to act on', async () => {
      const { wrapper } = await mountInfo()
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })

      wrapper.get('.song-info').element.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(false)
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
      useRadioMetadataStore().nowPlaying = 'Artist - Track'
      await wrapper.vm.$nextTick()

      expect(wrapper.get('.text-body-medium').text()).toBe('Artist - Track')
      expect(wrapper.get('.text-body-small').text()).toBe('Chill FM')
    })

    it('leaves its labels as plain text, with nowhere to click through to', async () => {
      // A station has no page of its own in this app, so neither the tag
      // nor the station name has anywhere to lead — and neither should
      // look or behave as though it did.
      const { wrapper, router } = await mountInfo()
      usePlaybackStore().radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      useRadioMetadataStore().nowPlaying = 'Artist - Track'
      await wrapper.vm.$nextTick()
      const push = vi.spyOn(router, 'push')

      await wrapper.get('.song-info__labels--inert').trigger('click')

      expect(push).not.toHaveBeenCalled()
    })

    it('still opens Now Playing from the artwork beside them', async () => {
      const { wrapper, router } = await mountInfo()
      usePlaybackStore().radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
      await wrapper.vm.$nextTick()
      const push = vi.spyOn(router, 'push')

      await wrapper.get('.song-info').trigger('click')

      expect(push).toHaveBeenCalledWith('/now-playing')
      expect(wrapper.get('.song-info').classes()).toContain('song-info--clickable')
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
