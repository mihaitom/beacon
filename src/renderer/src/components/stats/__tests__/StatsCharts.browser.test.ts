import { afterEach, describe, expect, it } from 'vitest'
import { mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import type { Artist } from '@/types/library'
import StatsCharts, { type ChartItem } from '../StatsCharts.vue'

const line = (id: string): ChartItem => ({
  id,
  label: `Song ${id}`,
  sublabel: 'Alpha',
  value: 1,
  valueLabel: '1',
  to: `/albums/${id}`,
  coverArtId: 'c',
})

function hitAt(element: Element): Element | null {
  element.scrollIntoView({ block: 'center' })
  const box = element.getBoundingClientRect()
  return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
}

describe('StatsCharts clicks', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => wrapper?.unmount())

  it('reaches the artist on an artist name and the line everywhere else', () => {
    setActivePinia(createPinia())
    useLibraryStore().artists = [{ id: 'a', name: 'Alpha' }] as Artist[]
    wrapper = mount(StatsCharts, {
      attachTo: document.body,
      props: {
        charts: { songs: [line('1'), line('2')], artists: [], albums: [], genres: [] },
      },
      global: {
        plugins: [createVuetify({ components, directives }), i18n],
        stubs: { CoverArt: true, RouterLink: RouterLinkStub },
      },
    })

    for (const scope of ['.stats-charts__first', '.stats-charts__row']) {
      const artist = wrapper.find(`${scope} .artist-credit__link`).element
      expect(hitAt(artist)?.closest('.artist-credit__link')).toBe(artist)
    }
    const title = wrapper.find('.stats-charts__row .stats-charts__title').element
    expect(hitAt(title)?.closest('.stats-charts__stretch')).not.toBeNull()
  })
})
