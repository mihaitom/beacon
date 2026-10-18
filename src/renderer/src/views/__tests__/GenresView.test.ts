import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
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

/** `count` songs in each genre - the genre list is counted from the songs. */
function songsIn(genres: Record<string, number>) {
  return Object.entries(genres).flatMap(([genre, count]) =>
    Array.from({ length: count }, (_, i) => makeSong(`${genre}-${i}`, { genre })),
  )
}

function mountView() {
  return mount(GenresView, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { DetailHeader: true, CoverArt: true, AlphabetIndexBar: true },
    },
  })
}

const crateNames = (wrapper: ReturnType<typeof mountView>) =>
  wrapper.findAll('.genre-crate__name').map((name) => name.text())
const registerNames = (wrapper: ReturnType<typeof mountView>) =>
  wrapper.findAll('.genre-register__name').map((name) => name.text())

describe('GenresView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const library = useLibraryStore()
    vi.spyOn(library, 'fetchGenres').mockResolvedValue()
    vi.spyOn(library, 'fetchAlbums').mockResolvedValue()
    library.allSongs = songsIn({
      Pop: 9,
      Rock: 8,
      House: 7,
      Jazz: 6,
      Blues: 5,
      Funk: 4,
      Soul: 3,
      Disco: 2,
      Ambient: 1,
      Trance: 1,
    })
  })

  it('shows the eight biggest genres as crates, biggest first', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(crateNames(wrapper)).toEqual([
      'Pop',
      'Rock',
      'House',
      'Jazz',
      'Blues',
      'Funk',
      'Soul',
      'Disco',
    ])
  })

  it('lists every genre in the register, alphabetically under its letter', async () => {
    const wrapper = mountView()
    await flushPromises()

    // The crates are a way in, not a cap: the smallest ones are here too.
    expect(registerNames(wrapper)).toEqual([
      'Ambient',
      'Blues',
      'Disco',
      'Funk',
      'House',
      'Jazz',
      'Pop',
      'Rock',
      'Soul',
      'Trance',
    ])
    expect(wrapper.findAll('.genre-register__letter').map((l) => l.text())).toEqual([
      'A',
      'B',
      'D',
      'F',
      'H',
      'J',
      'P',
      'R',
      'S',
      'T',
    ])
  })

  it('searches the whole register and drops the crates while it does', async () => {
    vi.useFakeTimers()
    const wrapper = mountView()
    await flushPromises()

    await wrapper.get('input[type="text"]').setValue('tran')
    await vi.advanceTimersByTimeAsync(250)

    expect(crateNames(wrapper)).toEqual([])
    expect(registerNames(wrapper)).toEqual(['Trance'])
    vi.useRealTimers()
  })

  it('sets the big genres stronger than the long tail of small ones', async () => {
    const wrapper = mountView()
    await flushPromises()
    const entry = (name: string) =>
      wrapper
        .findAll('.genre-register__entry')
        .find((e) => e.get('.genre-register__name').text() === name)!

    expect(entry('Pop').classes()).toContain('genre-register__entry--strong')
    expect(entry('Ambient').classes()).toContain('genre-register__entry--faint')
  })

  it('links every genre to its page', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.get('.genre-crate').attributes('href')).toBe('/genres/Pop')
  })
})
