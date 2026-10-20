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
import { useAuthStore } from '@/stores/auth'
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

async function mountCard(props: Record<string, unknown>) {
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
    props: { album, ...props },
    global: { plugins: [vuetify, i18n, router], stubs: { CoverArt: true } },
  })
  return { wrapper, router }
}

const mountTile = () => mountCard({ tile: true })

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

describe('AlbumCard as a list row', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rates the album from its stars without opening it', async () => {
    const rate = vi.spyOn(useLibraryStore(), 'rate').mockResolvedValue()
    const { wrapper, router } = await mountCard({ row: true, album: { ...album, rating: 0 } })

    await wrapper.findAll('.album-row__rating button')[3]!.trigger('click')
    await flushPromises()

    expect(rate).toHaveBeenCalledWith(expect.objectContaining({ id: 'al1' }), 4)
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('has no stars where the server has no rating scale', async () => {
    useAuthStore().serverType = 'jellyfin'
    const { wrapper } = await mountCard({ row: true })

    expect(wrapper.find('.album-row__rating').exists()).toBe(false)
  })
})
