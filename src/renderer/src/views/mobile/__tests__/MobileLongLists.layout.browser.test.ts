// Real-browser test for the phone's long lists - Queue, a playlist, the
// library and radio - run via `pnpm test:layout`. Which rows get mounted depends on the height
// of the shell's scrolling pane, which jsdom does not lay out.
//
// Every mounted row carries a cover with its own observer and skeleton; a
// 300-song playlist with all of them mounted froze WebKit until the visible
// covers had loaded (GitHub #47).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { flushPromises, mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
// Same order as main.ts - see MobileAppBar.layout.browser.test.ts.
import '@/assets/main.css'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { makeSong } from '@/stores/__tests__/fixtures'
import MobileLayout from '@/layouts/MobileLayout.vue'
import MobileQueueView from '../MobileQueueView.vue'
import MobilePlaylistDetailView from '../MobilePlaylistDetailView.vue'
import MobileLibraryView from '../MobileLibraryView.vue'
import MobileRadioView from '../MobileRadioView.vue'
import type { Album, RadioStation } from '@/types/library'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

const SONG_COUNT = 300
const songs = Array.from({ length: SONG_COUNT }, (_, index) => makeSong(`s${index}`))

// Only the fields the rows render, as rowHairline.browser.test.ts does.
const albums = Array.from(
  { length: SONG_COUNT },
  (_, index) =>
    ({ id: `al${index}`, name: `Album ${index}`, artist: 'A', coverArtId: null }) as Album,
)
const stations = Array.from(
  { length: SONG_COUNT },
  (_, index) =>
    ({ id: `r${index}`, name: `Station ${index}`, streamUrl: 'http://s/x' }) as RadioStation,
)

function mountShell(view: object, query: Record<string, string> = {}) {
  const wrapper = mount(MobileLayout, {
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      mocks: {
        $route: { path: '/m/queue', name: 'm-queue', params: { id: 'p1' }, query },
        $router: { push: vi.fn() },
        $emitter: emitter,
      },
      stubs: {
        RouterView: view,
        'router-view': view,
        MobilePlayerBar: true,
        CastTakeoverConfirmDialog: true,
        CoverArt: true,
        RouterLink: RouterLinkStub,
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

async function settle() {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 80))
}

/** Mounts `view`, checks that only part of the list is in the DOM, and that
 * scrolling to the end brings its last entry in. */
async function expectWindowed(
  view: object,
  rowSelector: string,
  lastText: string,
  query: Record<string, string> = {},
) {
  mountShell(view, query)
  await settle()

  const rows = () => [...document.querySelectorAll(rowSelector)]
  expect(rows().length).toBeGreaterThan(0)
  expect(rows().length).toBeLessThan(SONG_COUNT / 4)

  await scrollToEnd()
  expect(rows().some((row) => row.textContent?.includes(lastText))).toBe(true)
}

/** Scrolls the pane to its end and waits for the scroller to catch up. */
async function scrollToEnd() {
  const pane = document.querySelector('.v-main') as HTMLElement
  pane.scrollTop = pane.scrollHeight
  pane.dispatchEvent(new Event('scroll'))
  await settle()
}

describe('long mobile lists', () => {
  beforeEach(async () => {
    await page.viewport(390, 844)
    setActivePinia(createPinia())
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
    document.documentElement.classList.remove('mobile-shell')
  })

  it('mounts only the queue rows near the screen', async () => {
    usePlaybackStore().setQueue([...songs], 0)
    mountShell(MobileQueueView)
    await settle()

    const rows = () => document.querySelectorAll('.mobile-queue-row')
    expect(rows().length).toBeGreaterThan(0)
    expect(rows().length).toBeLessThan(SONG_COUNT / 4)

    // ...and still reaches the end of a long one.
    await scrollToEnd()
    const last = rows()[rows().length - 1] as HTMLElement
    expect(last.dataset.index).toBe(String(SONG_COUNT - 1))
  })

  it('mounts only the playlist rows near the screen', async () => {
    useAuthStore().username = 'thomas'
    vi.spyOn(useLibraryStore(), 'fetchPlaylist').mockResolvedValue({
      id: 'p1',
      name: 'Long one',
      songCount: SONG_COUNT,
      duration: 0,
      coverArtId: null,
      public: false,
      owner: 'thomas',
      changed: null,
      songs: [...songs],
    })
    await expectWindowed(MobilePlaylistDetailView, '.mobile-song-row', songs.at(-1)!.title)
  })

  describe('the library', () => {
    beforeEach(() => {
      const library = useLibraryStore()
      library.allSongs = [...songs]
      vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
    })

    it('mounts only the song rows near the screen', async () => {
      await expectWindowed(MobileLibraryView, '.mobile-song-row', songs.at(-1)!.title)
    })

    it('mounts only the album rows near the screen', async () => {
      const library = useLibraryStore()
      library.albums = [...albums]
      vi.spyOn(library, 'fetchAlbums').mockResolvedValue()
      await expectWindowed(MobileLibraryView, '.mobile-album-row', albums.at(-1)!.name, {
        tab: 'albums',
      })
    })
  })

  it('mounts only the radio rows near the screen', async () => {
    const library = useLibraryStore()
    library.radioStations = [...stations]
    vi.spyOn(library, 'fetchRadioStations').mockResolvedValue()
    await expectWindowed(MobileRadioView, '.radio-row', stations.at(-1)!.name)
  })
})
