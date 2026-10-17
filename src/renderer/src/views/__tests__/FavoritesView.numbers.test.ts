import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import FavoritesView from '../FavoritesView.vue'

const vuetify = createVuetify({ components, directives })

/** Counts are written the way the app's language writes numbers - the
 * page headers showed "12496" beside a statistics page saying "12.516". */
describe('counts in the language of the app', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const library = useLibraryStore()
    vi.spyOn(library, 'fetchStarred').mockImplementation(async () => {
      library.starred = {
        artists: [],
        albums: [],
        songs: Array.from({ length: 1234 }, (_, i) => makeSong(`s${i}`)),
      }
    })
  })

  afterEach(() => {
    ;(i18n.global.locale as unknown as string) = 'en'
  })

  it.each([
    ['de', '1.234 Titel'],
    ['en', '1,234 songs'],
  ])('%s: %s', async (locale, expected) => {
    ;(i18n.global.locale as unknown as string) = locale
    const wrapper = mount(FavoritesView, {
      global: {
        plugins: [vuetify, i18n],
        stubs: { DetailHeader: { template: '<div><slot name="meta" /></div>' }, SongTable: true },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain(expected)
  })
})
