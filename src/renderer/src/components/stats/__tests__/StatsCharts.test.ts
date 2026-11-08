import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import StatsCharts from '../StatsCharts.vue'

const vuetify = createVuetify({ components, directives })

const EMPTY = { songs: [], artists: [], albums: [], genres: [] }

function mountCharts(props: Record<string, unknown> = {}) {
  return mount(StatsCharts, {
    props: { charts: EMPTY, ...props },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
  })
}

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
