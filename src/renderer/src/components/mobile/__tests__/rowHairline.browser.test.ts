// Real-browser test for the separator every mobile list row draws — jsdom
// applies no CSS at all, so a border can only be measured here.
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@/assets/base.css'
import { i18n } from '@/i18n'
import MobileSongRow from '../MobileSongRow.vue'
import MobileQueueRow from '../MobileQueueRow.vue'
import MobilePlaylistRow from '../MobilePlaylistRow.vue'
import MobileAlbumRow from '../MobileAlbumRow.vue'
import MobileRadioRow from '@/components/mobile/MobileRadioRow.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Album, Playlist, RadioStation } from '@/types/library'

// Only the fields these rows actually render — cast rather than filled out,
// since what is under test here is a border, not a model.
function makePlaylist(id: string): Playlist {
  return { id, name: 'Mix', coverArtId: null, songCount: 2, duration: 60 } as Playlist
}

function makeAlbum(id: string): Album {
  return { id, name: 'Album', artist: 'Artist', coverArtId: null, year: 1999 } as Album
}

function makeStation(id: string): RadioStation {
  return { id, name: 'Station', streamUrl: 'http://s/x', homePageUrl: null } as RadioStation
}

const vuetify = createVuetify({ components, directives })
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
})

const ROWS = [
  { name: 'MobileSongRow', render: (i: number) => h(MobileSongRow, { song: makeSong(String(i)) }) },
  {
    name: 'MobileQueueRow',
    render: (i: number) => h(MobileQueueRow, { song: makeSong(String(i)), index: i }),
  },
  {
    name: 'MobilePlaylistRow',
    render: (i: number) => h(MobilePlaylistRow, { playlist: makePlaylist(`p${i}`) }),
  },
  {
    name: 'MobileAlbumRow',
    render: (i: number) => h(MobileAlbumRow, { album: makeAlbum(`a${i}`) }),
  },
  {
    name: 'MobileRadioRow',
    render: (i: number) => h(MobileRadioRow, { station: makeStation(`r${i}`) }),
  },
] as const

let currentWrapper: VueWrapper | null = null

async function mountList(entry: (typeof ROWS)[number]) {
  currentWrapper?.unmount()
  await page.viewport(390, 800)
  setActivePinia(createPinia())
  const wrapper = mount(
    {
      render: () =>
        h(components.VApp, null, {
          // Three siblings, so "between rows" and "after the last one" are
          // both real cases here.
          default: () => h('div', null, [entry.render(0), entry.render(1), entry.render(2)]),
        }),
    },
    { attachTo: document.body, global: { plugins: [vuetify, i18n, router] } },
  )
  currentWrapper = wrapper
  await wrapper.vm.$nextTick()
  await new Promise((resolve) => setTimeout(resolve, 60))
  return [...document.querySelectorAll('.mobile-row')] as HTMLElement[]
}

describe('the mobile row separator', () => {
  afterEach(() => {
    currentWrapper?.unmount()
    currentWrapper = null
  })

  it.each(ROWS.map((row) => [row.name, row] as const))(
    '%s draws a hairline between rows but not after the last',
    async (_name, entry) => {
      const rows = await mountList(entry)
      expect(rows).toHaveLength(3)

      expect(getComputedStyle(rows[0]!).borderBottomWidth).toBe('1px')
      expect(getComputedStyle(rows[1]!).borderBottomWidth).toBe('1px')
      expect(getComputedStyle(rows[2]!).borderBottomWidth).toBe('0px')
    },
  )

  /** Square ends, so a run of rows reads as one list. Rounded corners plus
   * a separator underneath read as a stack of cards instead, and four of
   * these lists had an 8px radius while the queue alone had none. */
  it.each(ROWS.map((row) => [row.name, row] as const))(
    '%s has square ends, so the hairline runs straight across',
    async (_name, entry) => {
      const rows = await mountList(entry)

      const radius = getComputedStyle(rows[0]!)
      expect(radius.borderTopLeftRadius).toBe('0px')
      expect(radius.borderTopRightRadius).toBe('0px')
      expect(radius.borderBottomLeftRadius).toBe('0px')
      expect(radius.borderBottomRightRadius).toBe('0px')
    },
  )

  /** The separator sits inside the row's own height (border-box), so adding
   * it must not have made any list taller than another. */
  it.each(ROWS.map((row) => [row.name, row] as const))(
    '%s stays the shared row height',
    async (_name, entry) => {
      const rows = await mountList(entry)

      expect(Math.round(rows[0]!.getBoundingClientRect().height)).toBe(60)
    },
  )
})
