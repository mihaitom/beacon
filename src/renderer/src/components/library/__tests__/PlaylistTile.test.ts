import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import PlaylistTile from '../PlaylistTile.vue'
import type { Playlist } from '@/types/library'

const vuetify = createVuetify({ components, directives })

function makePlaylist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: 'p1',
    name: 'My mix',
    songCount: 10,
    duration: 1800,
    coverArtId: null,
    public: false,
    owner: 'thomas',
    songs: [],
    ...overrides,
  }
}

async function mountTile(props: Partial<InstanceType<typeof PlaylistTile>['$props']> = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/playlists/:id', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()
  return {
    wrapper: mount(PlaylistTile, {
      props: { playlist: makePlaylist(), ...props },
      global: { plugins: [vuetify, i18n, router] },
    }),
    router,
  }
}

describe('PlaylistTile', () => {
  it('links the whole tile to the playlist detail page', async () => {
    const { wrapper } = await mountTile()

    expect(wrapper.get('a').attributes('href')).toBe('/playlists/p1')
  })

  it('clicking the cover overlay plays it instead of navigating to the detail page', async () => {
    const { wrapper, router } = await mountTile()
    const pushSpy = router.push

    await wrapper.get('.playlist-tile__play-overlay').trigger('click')

    expect(wrapper.emitted('play')).toEqual([[wrapper.props('playlist')]])
    // .prevent.stop on the overlay's own click handler — the tile is a
    // router-link, so without it this would also navigate away.
    expect(router.currentRoute.value.path).toBe('/')
    void pushSpy
  })

  it('shows the owner only when asked to, for the "other people\'s playlists" section', async () => {
    const withoutOwner = await mountTile({ playlist: makePlaylist({ owner: 'anna' }) })
    expect(withoutOwner.wrapper.text()).not.toContain('anna')

    const withOwner = await mountTile({
      playlist: makePlaylist({ owner: 'anna' }),
      showOwner: true,
    })
    expect(withOwner.wrapper.text()).toContain('anna')
  })

  it('shows a globe icon for a public playlist only', async () => {
    expect(
      (await mountTile({ playlist: makePlaylist({ public: true }) })).wrapper
        .find('.mdi-earth')
        .exists(),
    ).toBe(true)
    expect(
      (await mountTile({ playlist: makePlaylist({ public: false }) })).wrapper
        .find('.mdi-earth')
        .exists(),
    ).toBe(false)
  })
})
