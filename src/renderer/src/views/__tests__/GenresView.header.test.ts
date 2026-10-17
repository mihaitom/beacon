import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import GenresView from '../GenresView.vue'

const vuetify = createVuetify({ components, directives })
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
})

function mountView() {
  return mount(GenresView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: {
        DetailHeader: { template: '<div><slot name="meta" /></div>' },
      },
    },
  })
}

describe("the Genres page's header", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const library = useLibraryStore()
    vi.spyOn(library, 'fetchGenres').mockResolvedValue()
    // Genres come from the songs.
    library.allSongs = [
      makeSong('p1', { genre: 'Pop' }),
      makeSong('p2', { genre: 'Pop' }),
      makeSong('h', { genre: 'House', playCount: 12 }),
    ]
  })

  it('counts the genres', () => {
    expect(mountView().text()).toContain('2 Genres')
  })
})
