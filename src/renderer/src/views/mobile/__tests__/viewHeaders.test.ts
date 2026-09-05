import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import MobileLibraryView from '../MobileLibraryView.vue'
import MobilePlaylistsView from '../MobilePlaylistsView.vue'
import MobileQueueView from '../MobileQueueView.vue'
import MobileRadioView from '../MobileRadioView.vue'

const vuetify = createVuetify({ components, directives })

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
})

const VIEWS = [
  { name: 'MobileLibraryView', component: MobileLibraryView },
  { name: 'MobilePlaylistsView', component: MobilePlaylistsView },
  { name: 'MobileQueueView', component: MobileQueueView },
  { name: 'MobileRadioView', component: MobileRadioView },
] as const

function mountView(component: (typeof VIEWS)[number]['component']) {
  const library = useLibraryStore()
  vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
  vi.spyOn(library, 'fetchAlbums').mockResolvedValue()
  vi.spyOn(library, 'fetchPlaylists').mockResolvedValue()
  vi.spyOn(library, 'fetchRadioStations').mockResolvedValue()
  return mount(component as never, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { CoverArt: true, TileContextMenu: true },
    },
  })
}

/**
 * Four phone views that all open the same way — the view's name, then
 * whatever the view is — used to spell that four different ways: a bare h1
 * with mb-3, another with mb-4, one wrapped in `d-flex align-center mb-3`
 * utility classes and one with a flex block of its own. They sat at
 * different distances from their content as a result.
 */
describe('the mobile view headers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it.each(VIEWS.map((view) => [view.name, view.component] as const))(
    '%s opens with the shared header row',
    (_name, component) => {
      const wrapper = mountView(component)

      const header = wrapper.get('.mobile-header')
      // The app's own page type, not a per-view size.
      expect(header.find('.page-title').exists()).toBe(true)
      expect(header.find('.mobile-header__title').exists()).toBe(true)
    },
  )

  /** Radio's filter was sticky (it shares the desktop view) while the
   * library's and the playlists' scrolled away — the same list, behaving
   * differently depending on which tab you were on. */
  it.each([
    ['MobileLibraryView', MobileLibraryView],
    ['MobilePlaylistsView', MobilePlaylistsView],
  ] as const)('%s keeps its filter in reach while the list scrolls', (_name, component) => {
    const wrapper = mountView(component)

    expect(wrapper.findComponent({ name: 'StickyFilter' }).exists()).toBe(true)
  })
})
