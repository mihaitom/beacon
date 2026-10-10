// Real-browser test for the phone's two long lists, Queue and a playlist -
// run via `pnpm test:layout`. Which rows get mounted depends on the height
// of the shell's scrolling pane, which jsdom does not lay out.
//
// Every mounted row carries a cover with its own observer and skeleton; a
// 300-song playlist with all of them mounted froze WebKit until the visible
// covers had loaded (GitHub #47).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
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

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

const SONG_COUNT = 300
const songs = Array.from({ length: SONG_COUNT }, (_, index) => makeSong(`s${index}`))

function mountShell(view: object) {
  const wrapper = mount(MobileLayout, {
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      mocks: {
        $route: { path: '/m/queue', name: 'm-queue', params: { id: 'p1' } },
        $router: { push: vi.fn() },
        $emitter: emitter,
      },
      stubs: {
        RouterView: view,
        'router-view': view,
        MobilePlayerBar: true,
        CastTakeoverConfirmDialog: true,
        CoverArt: true,
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
    mountShell(MobilePlaylistDetailView)
    await settle()

    const rows = () => document.querySelectorAll('.mobile-song-row')
    expect(rows().length).toBeGreaterThan(0)
    expect(rows().length).toBeLessThan(SONG_COUNT / 4)

    await scrollToEnd()
    const titles = [...rows()].map((row) => row.textContent ?? '')
    expect(titles.some((text) => text.includes(songs[SONG_COUNT - 1]!.title))).toBe(true)
  })
})
