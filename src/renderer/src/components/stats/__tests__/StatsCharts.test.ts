import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import type { Artist } from '@/types/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import SongContextMenu from '@/components/library/SongContextMenu.vue'
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

describe('StatsCharts right-click menu', () => {
  const line = (id: string, over: Partial<ChartItem> = {}): ChartItem => ({
    id,
    label: `Line ${id}`,
    value: 1,
    valueLabel: '1',
    ...over,
  })

  function rightClick(target: Element): MouseEvent {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }

  function mountMenus(songs: ChartItem[]) {
    setActivePinia(createPinia())
    vi.spyOn(useLibraryStore(), 'fetchPlaylists').mockResolvedValue()
    return mount(StatsCharts, {
      props: { charts: { ...EMPTY, songs } },
      global: { plugins: [vuetify, i18n], stubs: { CoverArt: true, RouterLink: RouterLinkStub } },
    })
  }

  it('opens the song menu on the line right-clicked, the number one included', async () => {
    const first = makeSong('1')
    const second = makeSong('2')
    const wrapper = mountMenus([line('1', { song: first }), line('2', { song: second })])

    const event = rightClick(wrapper.find('.stats-charts__row').element)
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.findComponent(SongContextMenu).props('song').id).toBe('2')

    rightClick(wrapper.find('.stats-charts__first').element)
    await flushPromises()
    expect(wrapper.findComponent(SongContextMenu).props('song').id).toBe('1')
  })

  it('leaves a line the library does not have to the browser', async () => {
    const wrapper = mountMenus([line('1'), line('2')])

    const event = rightClick(wrapper.find('.stats-charts__row').element)
    await flushPromises()

    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.findComponent(SongContextMenu).exists()).toBe(false)
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
