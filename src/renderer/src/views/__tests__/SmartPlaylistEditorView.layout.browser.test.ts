// Real-browser check of the smart playlist editor's one layout decision:
// the preview beside the rules where the page is wide enough, under them
// where it is not. A container query, which jsdom does not evaluate.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
// Same order as main.ts - see RadioDiscoverDialog.layout.browser.test.ts.
import '@/assets/main.css'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import SmartPlaylistEditorView from '../SmartPlaylistEditorView.vue'

// Spelled out rather than importOriginal()'d, which deadlocks the browser
// runner (see RadioDiscoverDialog.layout.browser.test.ts).
vi.mock('@/services/navidrome/client', () => ({
  getNavidromePlaylist: vi.fn(),
  createSmartPlaylist: vi.fn(),
  updateSmartPlaylist: vi.fn(),
  loginToNavidrome: vi.fn(),
  NavidromeLoginRequired: class extends Error {},
  NavidromePasswordRejected: class extends Error {},
}))

const vuetify = createVuetify({ components, directives })

let current: VueWrapper | null = null

async function openAt(width: number) {
  current?.unmount()
  await page.viewport(width, 900)
  setActivePinia(createPinia())
  const library = useLibraryStore()
  // No rules yet, so every song is in the preview - this one included.
  library.allSongs = [
    makeSong('long', {
      title:
        'Lorien Testard, Alice Duport-Percier - Gestral Village (Fighting Theme, Extended Version)',
      artist: 'Lorien Testard, Alice Duport-Percier and the Expedition 33 Orchestra',
    }),
  ]
  library.allSongsLoaded = true
  vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
  vi.spyOn(library, 'fetchPlaylists').mockResolvedValue()
  vi.spyOn(library, 'fetchArtists').mockResolvedValue()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/playlists/smart/new', component: SmartPlaylistEditorView }],
  })
  await router.push('/playlists/smart/new')
  await router.isReady()
  current = mount(
    {
      render: () =>
        h(components.VApp, null, {
          default: () => h(components.VMain, null, { default: () => h(RouterView) }),
        }),
    },
    { attachTo: document.body, global: { plugins: [vuetify, i18n, router] } },
  )
  await flushPromises()
  // The preview runs debounced.
  await new Promise((resolve) => setTimeout(resolve, 250))
  await flushPromises()
  const rules = document.querySelector('.smart-editor__rules')!.getBoundingClientRect()
  const preview = document.querySelector('.smart-editor__aside')!.getBoundingClientRect()
  return { rules, preview }
}

afterEach(() => {
  current?.unmount()
  current = null
})

describe('SmartPlaylistEditorView layout', () => {
  it('puts the preview beside the rules on a wide page', async () => {
    const { rules, preview } = await openAt(1400)

    expect(preview.left).toBeGreaterThanOrEqual(rules.right)
    expect(preview.top).toBeLessThan(rules.bottom)
  })

  it('cuts a long title short instead of letting it run out of the preview', async () => {
    await openAt(1400)
    const panel = document.querySelector('.smart-preview') as HTMLElement
    const title = document.querySelector('.smart-preview__title') as HTMLElement

    expect(title).not.toBeNull()
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth)
    expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(
      panel.getBoundingClientRect().right,
    )
  })

  it('puts it under the rules on a narrow one, at full width', async () => {
    const { rules, preview } = await openAt(760)

    expect(preview.top).toBeGreaterThanOrEqual(rules.bottom)
    expect(Math.round(preview.width)).toBe(Math.round(rules.width))
  })
})
