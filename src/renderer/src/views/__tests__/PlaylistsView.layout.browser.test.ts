// The grid's records are sized in container units (100cqi of their card),
// which jsdom does not compute.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { i18n } from '@/i18n'
import '@/assets/base.css'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import PlaylistsView from '../PlaylistsView.vue'
import type { Playlist, Song } from '@/types/library'
import type { SubsonicClient } from '@/services/subsonic/client'

/** A render function: the browser suite runs the runtime-only Vue build. */
const CoverStub = defineComponent({
  props: { size: { type: [Number, String], required: true } },
  setup(props) {
    return () => {
      const edge = typeof props.size === 'number' ? `${props.size}px` : props.size
      return h('div', { class: 'cover', style: `width:${edge};height:${edge}` })
    }
  },
})
const HeaderStub = defineComponent({ setup: () => () => h('div') })

function makePlaylist(id: string): Playlist {
  return {
    id,
    name: `Playlist ${id}`,
    songCount: 2,
    duration: 400,
    coverArtId: null,
    public: false,
    owner: 'me',
    changed: null,
    readonly: false,
    smart: false,
    songs: [],
  }
}

const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)))

describe('the Playlists grid', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    localStorage.clear()
  })

  async function mountGrid() {
    setActivePinia(createPinia())
    useAuthStore().username = 'me'
    const library = useLibraryStore()
    library.playlists = ['a', 'b', 'c', 'd'].map(makePlaylist)
    vi.spyOn(library, 'fetchPlaylists').mockResolvedValue()
    vi.spyOn(library, 'client').mockReturnValue({
      getPlaylist: async (id: string) => ({
        ...makePlaylist(id),
        songs: [{ id: '1', artist: 'A', coverArtId: 'c' } as Song],
      }),
    } as unknown as SubsonicClient)

    const host = document.createElement('div')
    host.style.width = '1000px'
    document.body.appendChild(host)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:all(.*)*', component: HeaderStub }],
    })
    wrapper = mount(PlaylistsView, {
      attachTo: host,
      global: {
        plugins: [createVuetify({ components, directives }), i18n, router],
        stubs: { CoverArt: CoverStub, DetailHeader: HeaderStub },
      },
    })
    await flushPromises()
    await frame()

    return wrapper
  }

  it('makes each front record as wide as its column', async () => {
    await mountGrid()
    const card = document.querySelector('.playlist-card') as HTMLElement
    const cover = card.querySelector('.cover') as HTMLElement

    expect(card.getBoundingClientRect().width).toBeGreaterThanOrEqual(220)
    expect(cover.getBoundingClientRect().width).toBeCloseTo(card.getBoundingClientRect().width, 0)
  })

  it('goes back to the fixed artwork in the list', async () => {
    const view = await mountGrid()

    ;(view.vm as unknown as { setListView: (list: boolean) => void }).setListView(true)
    await frame()

    const cover = document.querySelector('.playlist-card .cover') as HTMLElement
    expect(cover.getBoundingClientRect().width).toBe(96)
  })
})
