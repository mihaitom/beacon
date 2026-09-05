// The library screen can be arrived at with a search term already chosen —
// the radio title log's "find this in my library" is the caller today, and
// on this layout it comes here rather than to the desktop search page it
// used to land on. Kept in its own file so MobileLibraryView.test.ts, which
// mounts without a router at all, stays exactly as it is.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import MobileLibraryView from '../MobileLibraryView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

const SONGS = [
  makeSong('s1', { title: 'Show Me Love', artist: 'WizTheMc' }),
  makeSong('s2', { title: 'Something Else', artist: 'Another Band' }),
]

function mountWithRoute(route: { query: Record<string, string> }) {
  return mount(MobileLibraryView, {
    global: {
      plugins: [vuetify, i18n],
      stubs: { CoverArt: true, MobileSongActionSheet: true },
      mocks: { $route: route },
    },
  })
}

function vmOf(wrapper: ReturnType<typeof mountWithRoute>) {
  return wrapper.vm as unknown as { filterQuery: string; debouncedQuery: string }
}

describe('MobileLibraryView search hand-over', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const library = useLibraryStore()
    vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
    vi.spyOn(library, 'fetchAlbums').mockResolvedValue()
    library.allSongs = SONGS
    library.albums = []
  })

  it('arrives already filtered by the term it was handed', async () => {
    const wrapper = mountWithRoute({ query: { q: 'Show Me Love' } })
    await flushPromises()

    // Both, not just the field: going through the debounce would show the
    // whole library first and the result 200ms later.
    expect(vmOf(wrapper).filterQuery).toBe('Show Me Love')
    expect(vmOf(wrapper).debouncedQuery).toBe('Show Me Love')
    expect(wrapper.text()).toContain('Show Me Love')
    expect(wrapper.text()).not.toContain('Something Else')
  })

  it('picks up a second hand-over while already open', async () => {
    // Vue Router reuses this component when only the query changes, so
    // reading it once on create would silently ignore every term after the
    // first.
    // Reactive, because that is what a real $route is — a plain object
    // would never fire the watcher this test is about.
    const route = reactive({ query: { q: 'Show Me Love' } })
    const wrapper = mountWithRoute(route)
    await flushPromises()

    route.query = { q: 'Something Else' }
    await wrapper.vm.$nextTick()
    await flushPromises()

    expect(vmOf(wrapper).debouncedQuery).toBe('Something Else')
  })

  it('leaves the field alone when nothing was handed over', async () => {
    const wrapper = mountWithRoute({ query: {} })
    await flushPromises()

    expect(vmOf(wrapper).filterQuery).toBe('')
    expect(wrapper.text()).toContain('Show Me Love')
    expect(wrapper.text()).toContain('Something Else')
  })
})
