import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import PlaylistCard from '../PlaylistCard.vue'
import { extractDominantColor } from '@/services/colorExtractor'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Playlist } from '@/types/library'
import type { SubsonicClient } from '@/services/subsonic/client'

vi.mock('@/services/colorExtractor', () => ({ extractDominantColor: vi.fn() }))

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
    changed: null,
    readonly: false,
    smart: false,
    songs: [],
    ...overrides,
  }
}

type CardProps = Partial<InstanceType<typeof PlaylistCard>['$props']>

async function mountRow(props: CardProps = {}) {
  return mountCard({ row: true, ...props })
}

async function mountCard(props: CardProps = {}) {
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
    wrapper: mount(PlaylistCard, {
      props: { playlist: makePlaylist(), ...props },
      global: { plugins: [vuetify, i18n, router], stubs: { CoverArt: true } },
    }),
    router,
  }
}

let getPlaylist: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  getPlaylist = vi.fn().mockResolvedValue(makePlaylist())
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
    getPlaylist,
    coverArtUrl: (id: string) => `/cover/${id}`,
  } as unknown as SubsonicClient)
})

describe('PlaylistCard', () => {
  it('links the whole row to the playlist detail page', async () => {
    const { wrapper } = await mountRow()

    expect(wrapper.get('a').attributes('href')).toBe('/playlists/p1')
  })

  /** Clicks the button holding `icon` and reports whether the click was
   * kept from the row's link. Asked of the event rather than the router:
   * RouterLink does not navigate on a synthetic click in jsdom at all, so a
   * "still on /" check passes whether or not the button stops it. */
  function clickKeptFromLink(wrapper: ReturnType<typeof mount>, icon: string): boolean {
    let reachedLink = false
    wrapper.element.addEventListener('click', () => (reachedLink = true))
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    wrapper.get(icon).element.closest('button')!.dispatchEvent(event)
    return event.defaultPrevented && !reachedLink
  }

  it('plays from its play button without opening the playlist', async () => {
    const { wrapper } = await mountRow()

    expect(clickKeptFromLink(wrapper, '.mdi-play')).toBe(true)
    expect(wrapper.emitted('play')).toEqual([[wrapper.props('playlist')]])
  })

  it('previews the playlist from its preview button, without opening it', async () => {
    const songs = [makeSong('1'), makeSong('2')]
    vi.spyOn(useLibraryStore(), 'fetchPlaylist').mockResolvedValue(makePlaylist({ songs }))
    const preview = vi.spyOn(usePlaybackStore(), 'startPreview').mockResolvedValue()
    const { wrapper } = await mountRow()

    expect(clickKeptFromLink(wrapper, '.mdi-headphones')).toBe(true)
    await flushPromises()
    expect(preview).toHaveBeenCalledWith(songs)
  })

  it('offers no playing of an empty playlist', async () => {
    const { wrapper } = await mountRow({ playlist: makePlaylist({ songCount: 0 }) })

    expect(wrapper.get('.mdi-play').element.closest('button')!.disabled).toBe(true)
    expect(wrapper.get('.mdi-headphones').element.closest('button')!.disabled).toBe(true)
  })

  it('says how long ago it was edited, where the server says', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-06T12:00:00Z'), toFake: ['Date'] })
    const { wrapper } = await mountRow({
      playlist: makePlaylist({ changed: '2026-10-03T12:00:00Z' }),
    })
    vi.useRealTimers()

    expect(wrapper.text()).toContain('3 days ago')
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

  it("names the playlist's main artists and genres once its songs are in", async () => {
    getPlaylist.mockResolvedValue(
      makePlaylist({
        songs: [
          makeSong('1', { artist: 'Portishead', genre: 'Trip-Hop' }),
          makeSong('2', { artist: 'Radiohead', genre: 'Rock' }),
          makeSong('3', { artist: 'Radiohead', genre: 'Rock' }),
          makeSong('4', { artist: 'Björk' }),
          makeSong('5', { artist: 'Tricky' }),
          makeSong('6', { artist: 'Moby' }),
        ],
      }),
    )
    const { wrapper } = await mountRow()
    await flushPromises()

    expect(getPlaylist).toHaveBeenCalledWith('p1')
    expect(wrapper.text()).toContain('With Radiohead, Portishead, Björk and 2 more')
    const chips = wrapper.findAllComponents({ name: 'VChip' }).map((chip) => chip.text())
    expect(chips).toEqual(['Rock', 'Trip-Hop'])
  })

  it("shows the playlist's own albums rather than the server's artwork", async () => {
    getPlaylist.mockResolvedValue(
      makePlaylist({ songs: [makeSong('1', { coverArtId: 'album-art' })] }),
    )
    const { wrapper } = await mountRow({ playlist: makePlaylist({ coverArtId: 'server-art' }) })
    await flushPromises()

    const shown = wrapper.findAllComponents({ name: 'CoverArt' }).map((c) => c.props('coverArtId'))
    expect(shown).toContain('album-art')
    expect(shown).not.toContain('server-art')
  })

  it("falls back to the server's artwork when the songs cannot be read", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getPlaylist.mockRejectedValue(new Error('500'))
    const { wrapper } = await mountRow({ playlist: makePlaylist({ coverArtId: 'server-art' }) })
    await flushPromises()

    const shown = wrapper.findAllComponents({ name: 'CoverArt' }).map((c) => c.props('coverArtId'))
    expect(shown).toContain('server-art')
  })

  it('cycles its artwork only while hovered', async () => {
    const { wrapper } = await mountRow()
    // The stack takes the skeleton's place once the albums are read.
    await flushPromises()
    const cover = wrapper.findComponent({ name: 'RecordStack' })
    expect(cover.props('browsing')).toBe(false)

    await wrapper.trigger('mouseenter')
    expect(cover.props('browsing')).toBe(true)

    await wrapper.trigger('mouseleave')
    expect(cover.props('browsing')).toBe(false)
  })

  describe('in the grid', () => {
    const artOf = (id: string) => makePlaylist({ songs: [makeSong(id, { coverArtId: id })] })

    it('plays from the button on its cover without opening the playlist', async () => {
      const { wrapper } = await mountCard()

      expect(clickKeptFromLink(wrapper, '.mdi-play')).toBe(true)
      expect(wrapper.emitted('play')).toEqual([[wrapper.props('playlist')]])
    })

    it('previews from the button on its cover without opening the playlist', async () => {
      const songs = [makeSong('1')]
      vi.spyOn(useLibraryStore(), 'fetchPlaylist').mockResolvedValue(makePlaylist({ songs }))
      const preview = vi.spyOn(usePlaybackStore(), 'startPreview').mockResolvedValue()
      const { wrapper } = await mountCard()

      expect(clickKeptFromLink(wrapper, '.mdi-headphones')).toBe(true)
      await flushPromises()
      expect(preview).toHaveBeenCalledWith(songs)
    })

    it('names two artists and counts the rest', async () => {
      getPlaylist.mockResolvedValue(
        makePlaylist({
          songs: ['A', 'B', 'C', 'D'].map((artist) => makeSong(artist, { artist })),
        }),
      )
      const { wrapper } = await mountCard()
      await flushPromises()

      expect(wrapper.text()).toContain('A, B')
      expect(wrapper.text()).toContain('+2')
      expect(wrapper.text()).not.toContain('C')
    })

    it('marks a smart playlist', async () => {
      const { wrapper } = await mountCard({ playlist: makePlaylist({ smart: true }) })

      expect(wrapper.find('.mdi-auto-fix').exists()).toBe(true)
    })

    it('reads a cover for its glow only once it is browsed', async () => {
      vi.mocked(extractDominantColor).mockReset().mockResolvedValue([10, 20, 30])
      getPlaylist.mockResolvedValue(artOf('front'))
      const { wrapper } = await mountCard()
      await flushPromises()
      expect(extractDominantColor).not.toHaveBeenCalled()

      await wrapper.trigger('mouseenter')
      await flushPromises()

      expect(extractDominantColor).toHaveBeenCalledWith('/cover/front')
      expect(wrapper.get('.playlist-card__glow').attributes('style')).toContain('rgb(10, 20, 30)')
    })

    it('drops a colour that arrives after the pointer has left', async () => {
      let answer: (color: [number, number, number]) => void = () => {}
      vi.mocked(extractDominantColor)
        .mockReset()
        .mockReturnValue(new Promise((resolve) => (answer = resolve)))
      getPlaylist.mockResolvedValue(artOf('front'))
      const { wrapper } = await mountCard()
      await flushPromises()

      await wrapper.trigger('mouseenter')
      await wrapper.trigger('mouseleave')
      answer([10, 20, 30])
      await flushPromises()

      expect(wrapper.get('.playlist-card__glow').attributes('style') ?? '').not.toContain('rgb')
    })
  })
})
