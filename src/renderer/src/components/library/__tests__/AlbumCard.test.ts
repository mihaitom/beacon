import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { makeSong } from '@/stores/__tests__/fixtures'
import AlbumCard from '../AlbumCard.vue'
import type { Album } from '@/types/library'

const vuetify = createVuetify({ components, directives })

const album = {
  id: 'al1',
  name: 'Some Album',
  artist: 'Someone',
  artistId: 'ar1',
  coverArtId: null,
  songCount: 2,
  duration: 400,
  starred: false,
} as unknown as Album

async function mountTile() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/albums/:id', component: { template: '<div />' } },
      { path: '/artists/:id', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(AlbumCard, {
    props: { album, tile: true },
    global: { plugins: [vuetify, i18n, router], stubs: { CoverArt: true } },
  })
  return { wrapper }
}

describe('AlbumCard as a tile', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('plays the album wherever the tile is clicked', async () => {
    const songs = [makeSong('a'), makeSong('b')]
    vi.spyOn(useLibraryStore(), 'fetchAlbum').mockResolvedValue({ ...album, songs })
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const { wrapper } = await mountTile()

    await wrapper.trigger('click')
    await flushPromises()

    expect(play).toHaveBeenCalledWith(songs, 0, false, true)
  })

  it('opens the album from its name instead of playing it', async () => {
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const { wrapper } = await mountTile()
    const name = wrapper.find('a.album-tile__name')

    await name.trigger('click')
    await flushPromises()

    expect(play).not.toHaveBeenCalled()
    expect(name.attributes('href')).toBe('/albums/al1')
  })
})
