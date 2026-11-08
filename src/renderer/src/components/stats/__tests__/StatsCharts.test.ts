import { describe, expect, it } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import type { Artist } from '@/types/library'
import StatsCharts, { type ChartItem } from '../StatsCharts.vue'

const vuetify = createVuetify({ components, directives })

const EMPTY = { songs: [], artists: [], albums: [], genres: [] }

function mountCharts(props: Record<string, unknown> = {}) {
  return mount(StatsCharts, {
    props: { charts: EMPTY, ...props },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
  })
}

describe('StatsCharts lines', () => {
  const line = (id: string, over: Partial<ChartItem> = {}): ChartItem => ({
    id,
    label: `Line ${id}`,
    value: 1,
    valueLabel: '1',
    coverArtId: 'c',
    ...over,
  })

  function mountLines(charts: Partial<Record<string, ChartItem[]>>) {
    setActivePinia(createPinia())
    useLibraryStore().artists = [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ] as Artist[]
    return mount(StatsCharts, {
      props: { charts: { ...EMPTY, ...charts } },
      global: {
        plugins: [vuetify, i18n],
        stubs: { CoverArt: true, RouterLink: RouterLinkStub },
      },
    })
  }

  const targets = (wrapper: ReturnType<typeof mountLines>) =>
    wrapper.findAllComponents(RouterLinkStub).map((link) => link.props('to'))

  it('links each artist of a line apart from the line itself', () => {
    const items = ['1', '2'].map((id) =>
      line(id, { sublabel: 'Alpha feat. Beta', to: `/albums/${id}` }),
    )

    const wrapper = mountLines({ songs: items })

    expect(targets(wrapper)).toEqual([
      '/albums/1',
      '/artists/a',
      '/artists/b',
      '/albums/2',
      '/artists/a',
      '/artists/b',
    ])
    expect(wrapper.find('a a').exists()).toBe(false)
  })

  it('splits a credit standing as a line of the artist chart', async () => {
    const wrapper = mountLines({
      artists: [line('1'), line('2', { label: 'Alpha & Beta', artistId: 'a', to: '/artists/a' })],
    })

    await wrapper.setData({ tab: 'artists' })

    expect(targets(wrapper)).toEqual(['/artists/a', '/artists/a', '/artists/b'])
  })

  it('leaves a line nothing is known about without a link', () => {
    const wrapper = mountLines({ songs: [line('1'), line('2', { sublabel: 'Nobody' })] })

    expect(targets(wrapper)).toEqual([])
    expect(wrapper.text()).toContain('Nobody')
  })
})

describe('StatsCharts period picker', () => {
  it('stays hidden until the log has something to narrow', () => {
    expect(mountCharts().find('.stats-charts__period').exists()).toBe(false)
    expect(mountCharts({ showPeriod: true }).find('.stats-charts__period').exists()).toBe(true)
  })

  it('tells the page which window was chosen', () => {
    const wrapper = mountCharts({ showPeriod: true, period: 'all_time' })

    wrapper.findComponent(components.VSelect).vm.$emit('update:modelValue', 'month')

    expect(wrapper.emitted('update:period')).toEqual([['month']])
  })

  it('says so when the chosen window has nothing in it', () => {
    const wrapper = mountCharts({ showPeriod: true })

    expect(wrapper.text()).toContain(i18n.global.t('stats.chartsEmptyPeriod'))
  })
})
