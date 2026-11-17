import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import { i18n } from '@/i18n'
import type { Moment } from '@/services/library/statsMilestones'
import StatsMoment from '../StatsMoment.vue'
import StatsMomentCassette from '../StatsMomentCassette.vue'
import StatsMomentReel from '../StatsMomentReel.vue'

const vuetify = createVuetify({ components })

function mountMoment(moment: Moment, target = vi.fn(() => null)) {
  return mount(StatsMoment, {
    props: { moment, subtitle: '', target },
    global: { plugins: [vuetify, i18n], stubs: { teleport: true } },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('StatsMoment', () => {
  it('keeps the record for what is counted in records', () => {
    const wrapper = mountMoment({ kind: 'pressing', value: 3, size: 'l', tier: 'gold' })
    expect(wrapper.find('.stats-moment__vinyl').exists()).toBe(true)
    expect(wrapper.findComponent(StatsMomentReel).exists()).toBe(false)
  })

  it('shows hours on a reel', () => {
    const wrapper = mountMoment({ kind: 'hours', value: 100, size: 's' })
    expect(wrapper.findComponent(StatsMomentReel).exists()).toBe(true)
    expect(wrapper.find('.stats-moment__vinyl').exists()).toBe(false)
  })

  it('shows a streak on a cassette', () => {
    const wrapper = mountMoment({ kind: 'streak', value: 30, size: 'm' })
    expect(wrapper.findComponent(StatsMomentCassette).exists()).toBe(true)
    expect(wrapper.find('.stats-moment__vinyl').exists()).toBe(false)
  })

  it('asks where to land when it is closed', async () => {
    const target = vi.fn(() => null)
    const wrapper = mountMoment({ kind: 'hours', value: 100, size: 's' }, target)
    await wrapper.find('.stats-moment').trigger('click')
    expect(target).toHaveBeenCalled()
    expect(wrapper.emitted('closed')).toHaveLength(1)
  })
})
