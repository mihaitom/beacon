import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import PlaylistRow from '../PlaylistRow.vue'
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

async function mountRow(props: Partial<InstanceType<typeof PlaylistRow>['$props']> = {}) {
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
    wrapper: mount(PlaylistRow, {
      props: { playlist: makePlaylist(), ...props },
      global: { plugins: [vuetify, i18n, router] },
    }),
    router,
  }
}

describe('PlaylistRow', () => {
  it('links the whole row to the playlist detail page', async () => {
    const { wrapper } = await mountRow()

    expect(wrapper.get('a').attributes('href')).toBe('/playlists/p1')
  })

  it('clicking the cover overlay plays it instead of navigating to the detail page', async () => {
    const { wrapper, router } = await mountRow()
    const pushSpy = router.push

    await wrapper.get('.playlist-row__play-overlay').trigger('click')

    expect(wrapper.emitted('play')).toEqual([[wrapper.props('playlist')]])
    // .prevent.stop on the overlay's own click handler — the row is a
    // router-link, so without it this would also navigate away.
    expect(router.currentRoute.value.path).toBe('/')
    void pushSpy
  })

  it('shows the owner only when asked to, for the "other people\'s playlists" section', async () => {
    const withoutOwner = await mountRow({ playlist: makePlaylist({ owner: 'anna' }) })
    expect(withoutOwner.wrapper.text()).not.toContain('anna')

    const withOwner = await mountRow({
      playlist: makePlaylist({ owner: 'anna' }),
      showOwner: true,
    })
    expect(withOwner.wrapper.text()).toContain('anna')
  })

  it('shows a globe icon for a public playlist only', async () => {
    expect(
      (await mountRow({ playlist: makePlaylist({ public: true }) })).wrapper
        .find('.mdi-earth')
        .exists(),
    ).toBe(true)
    expect(
      (await mountRow({ playlist: makePlaylist({ public: false }) })).wrapper
        .find('.mdi-earth')
        .exists(),
    ).toBe(false)
  })
})
