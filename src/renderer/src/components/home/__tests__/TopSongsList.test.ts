import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { makeSong } from '@/stores/__tests__/fixtures'
import TopSongsList from '../TopSongsList.vue'
import type { Song } from '@/types/library'

const vuetify = createVuetify({ components, directives })

const fifteen = Array.from({ length: 15 }, (_, i) => makeSong(`s${i}`, { playCount: 15 - i }))

/** jsdom lays nothing out, so the list's width is what the test says. */
function mountAtWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
  return mount(TopSongsList, {
    props: { title: 'Most played', songs: fifteen },
    global: { plugins: [vuetify, i18n], stubs: { SongCard: true } },
  })
}

function playedOnPlayAll(wrapper: ReturnType<typeof mountAtWidth>): Song[] {
  wrapper.find(`[title="${i18n.global.t('home.playAll')}"]`).trigger('click')
  return wrapper.emitted('play-all')![0]![0] as Song[]
}

describe('TopSongsList', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('plays what it shows, not the songs a wider window would add', () => {
    const wrapper = mountAtWidth(1000)

    expect(playedOnPlayAll(wrapper)).toEqual(fifteen.slice(0, 10))
  })

  it('shows and plays a third column of songs on a wide window', async () => {
    const wrapper = mountAtWidth(1800)
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('li')).toHaveLength(15)
    expect(playedOnPlayAll(wrapper)).toEqual(fifteen)
  })
})
