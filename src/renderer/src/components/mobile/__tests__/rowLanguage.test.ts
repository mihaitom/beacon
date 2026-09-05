import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import MobileSongRow from '../MobileSongRow.vue'
import MobileQueueRow from '../MobileQueueRow.vue'
import MobilePlaylistRow from '../MobilePlaylistRow.vue'
import MobileAlbumRow from '../MobileAlbumRow.vue'
import MobileRadioRow from '@/components/mobile/MobileRadioRow.vue'
import { MOBILE_ROW_ART_SIZE } from '../rowMetrics'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
})

/** Every list row a phone shows, with the props each one needs. */
const ROWS = [
  { name: 'MobileSongRow', component: MobileSongRow, props: { song: makeSong('a') } },
  {
    name: 'MobileQueueRow',
    component: MobileQueueRow,
    props: { song: makeSong('a'), index: 0 },
  },
  {
    name: 'MobilePlaylistRow',
    component: MobilePlaylistRow,
    props: {
      playlist: { id: 'p1', name: 'Mix', coverArtId: null, songCount: 3, duration: 600 },
    },
  },
  {
    name: 'MobileAlbumRow',
    component: MobileAlbumRow,
    props: {
      album: { id: 'al1', name: 'Album', artist: 'Artist', coverArtId: null, year: 1999 },
    },
  },
  {
    name: 'MobileRadioRow',
    component: MobileRadioRow,
    props: {
      station: { id: 'r1', name: 'Station', streamUrl: 'http://s/x', homePageUrl: null },
    },
  },
] as const

function mountRow(entry: (typeof ROWS)[number]) {
  return mount(entry.component as never, {
    props: entry.props as never,
    global: {
      plugins: [vuetify, i18n, router],
      // Named, so findComponent({ name: 'CoverArt' }) still resolves it —
      // the size prop is the whole point of this file.
      stubs: {
        CoverArt: { name: 'CoverArt', template: '<div class="cover-stub" />', props: ['size'] },
      },
    },
  })
}

/**
 * Queue, Songs, Albums, Playlists and Radio were built at different times
 * and drifted: 40/44/52px artwork, three title treatments, four paddings —
 * five near-misses that read as five authors. The metrics now live in one
 * rule (.mobile-row in assets/base.css) and one constant, and this is what
 * keeps a sixth row, or an edit to an existing one, from wandering off
 * again.
 */
describe('the mobile row language', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it.each(ROWS.map((row) => [row.name, row] as const))(
    '%s uses the shared row metrics',
    (_name, entry) => {
      const wrapper = mountRow(entry)

      // The class that carries height, padding and alignment for all five.
      // get() throws when the selector misses, so these are the assertion;
      // .exists() on its return value is always true by construction.
      expect(wrapper.find('.mobile-row').exists()).toBe(true)
      expect(wrapper.find('.mobile-row__art').exists()).toBe(true)
      expect(wrapper.find('.mobile-row__text').exists()).toBe(true)
    },
  )

  it.each(ROWS.map((row) => [row.name, row] as const))(
    '%s asks for artwork at the shared size',
    (_name, entry) => {
      const wrapper = mountRow(entry)

      expect(wrapper.getComponent({ name: 'CoverArt' }).props('size')).toBe(MOBILE_ROW_ART_SIZE)
    },
  )

  /** Type stays on Vuetify's own scale rather than per-component rem
   * values — one row used 0.95rem/0.78rem and two used the next size up. */
  it.each(ROWS.map((row) => [row.name, row] as const))(
    '%s titles on the shared type scale',
    (_name, entry) => {
      const wrapper = mountRow(entry)
      const text = wrapper.get('.mobile-row__text')

      expect(text.find('.text-body-medium').exists()).toBe(true)
      expect(text.find('.text-body-large').exists()).toBe(false)
    },
  )
})
