// Only the search/filter field is covered here — that's the part with
// logic (matchesAllTerms, see services/textSearch.ts); everything else in
// this view is presentational markup driven off the library store.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import SongsView from '../SongsView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function mountView() {
  const library = useLibraryStore()
  vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
  library.allSongs = [
    makeSong('1', { title: 'Bad', artist: 'Michael Jackson', album: 'Bad' }),
    makeSong('2', { title: 'Thriller', artist: 'Michael Jackson', album: 'Thriller' }),
    makeSong('3', { title: 'Roar', artist: 'Katy Perry', album: 'Prism' }),
  ]
  return mount(SongsView, {
    global: {
      plugins: [vuetify, i18n],
      // StickyFilter.vue uses a real IntersectionObserver, which jsdom
      // doesn't implement — unrelated to what's under test here (the
      // filter's own matching logic, not its sticky-on-scroll behavior).
      stubs: { SongTable: true, CoverArt: true, StickyFilter: true },
    },
  })
}

async function withQuery(wrapper: ReturnType<typeof mountView>, query: string) {
  const vm = wrapper.vm as unknown as { debouncedQuery: string }
  vm.debouncedQuery = query
  await wrapper.vm.$nextTick()
}

describe('SongsView filter', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // Regression test (reported live 2026-08-25): the global top-bar search
  // finds "Michael Jackson Bad" by matching "Michael Jackson" against the
  // artist and "Bad" against the title — this view's own filter used to
  // require one single field to contain the *whole* typed string, so
  // neither that combined query nor anything splitting across two fields
  // ever matched here, even though each half alone did.
  it('matches a query split across the artist and title fields', async () => {
    const wrapper = mountView()

    await withQuery(wrapper, 'Michael Jackson Bad')

    const songs = wrapper.getComponent({ name: 'SongTable' }).props('songs') as { id: string }[]
    expect(songs.map((s) => s.id)).toEqual(['1'])
  })

  it('still matches on the artist alone', async () => {
    const wrapper = mountView()

    await withQuery(wrapper, 'Michael Jackson')

    const songs = wrapper.getComponent({ name: 'SongTable' }).props('songs') as { id: string }[]
    expect(songs.map((s) => s.id).sort()).toEqual(['1', '2'])
  })

  it('still matches on the title alone', async () => {
    const wrapper = mountView()

    await withQuery(wrapper, 'Bad')

    const songs = wrapper.getComponent({ name: 'SongTable' }).props('songs') as { id: string }[]
    expect(songs.map((s) => s.id)).toEqual(['1'])
  })

  it('finds nothing when a word genuinely does not appear anywhere', async () => {
    const wrapper = mountView()

    await withQuery(wrapper, 'Michael Jackson Roar')

    const songs = wrapper.getComponent({ name: 'SongTable' }).props('songs') as { id: string }[]
    expect(songs).toEqual([])
  })

  it('shows every song when the filter is empty', async () => {
    const wrapper = mountView()

    const songs = wrapper.getComponent({ name: 'SongTable' }).props('songs') as { id: string }[]
    expect(songs).toHaveLength(3)
  })
})
