import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import type { Album, Artist, Song } from '@/types/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import SearchView from '../SearchView.vue'

const vuetify = createVuetify({ components, directives })

interface SearchViewVm {
  query: string
  readonly hasResults: boolean
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/search', name: 'search', component: { template: '<div />' } },
    ],
  })
}

async function mountSearchView(route = '/search?q=moon') {
  const store = useLibraryStore()
  store.search = vi.fn().mockResolvedValue(undefined)

  const router = makeRouter()
  await router.push(route)
  await router.isReady()

  const wrapper = mount(SearchView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { CoverArt: true, AlbumCard: true, SongTable: true },
    },
  })
  await flushPromises()
  return { wrapper, store, router, vm: wrapper.vm as unknown as SearchViewVm }
}

function setResults(
  store: ReturnType<typeof useLibraryStore>,
  results: { artists?: Artist[]; albums?: Album[]; songs?: Song[] },
): void {
  store.searchResults = {
    artists: results.artists ?? [],
    albums: results.albums ?? [],
    songs: results.songs ?? [],
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('SearchView reacting to the route', () => {
  it('searches for the query it was opened with', async () => {
    const { store, vm } = await mountSearchView('/search?q=moon')

    expect(store.search).toHaveBeenCalledWith('moon')
    expect(vm.query).toBe('moon')
  })

  it('searches again when a new query arrives on the same page', async () => {
    const { store, router, vm } = await mountSearchView('/search?q=first')

    await router.push('/search?q=second')
    await flushPromises()

    // Vue Router reuses the component here (same path, only the query
    // differs), so relying on created() alone would silently do nothing
    // for every search after the first.
    expect(store.search).toHaveBeenCalledWith('second')
    expect(vm.query).toBe('second')
  })

  it('ignores a route with no query at all', async () => {
    const { store } = await mountSearchView('/search')

    expect(store.search).not.toHaveBeenCalled()
  })

  it('ignores a repeated query parameter rather than searching for a list', async () => {
    // ?q=a&q=b arrives as an array, not a string.
    const { store } = await mountSearchView('/search?q=a&q=b')

    expect(store.search).not.toHaveBeenCalled()
  })
})

describe('SearchView result presence', () => {
  it('reports nothing found when every category is empty', async () => {
    const { store, vm } = await mountSearchView()
    setResults(store, {})
    await flushPromises()

    expect(vm.hasResults).toBe(false)
  })

  it.each([
    ['artists', { artists: [{ id: 'a' } as Artist] }],
    ['albums', { albums: [{ id: 'b' } as Album] }],
    ['songs', { songs: [makeSong('s')] }],
  ])('reports results when only %s matched', async (_label, results) => {
    const { store, vm } = await mountSearchView()
    setResults(store, results)
    await flushPromises()

    // Any one category on its own counts: a check that ANDs the three
    // together, or looks at only one of them, would show "nothing found"
    // over a page of real results.
    expect(vm.hasResults).toBe(true)
  })
})
