import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import { i18n } from '@/i18n'
import StatsHero from '../StatsHero.vue'
import StatsRecord from '../StatsRecord.vue'

const vuetify = createVuetify({ components })

function backdrop(props: Record<string, unknown>): string | undefined {
  const wrapper = mount(StatsHero, {
    props: { plays: 10, ...props },
    global: { plugins: [vuetify, i18n], stubs: { StatsRecord: true } },
  })
  return wrapper.find('.stats-hero__art').attributes('style')
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('StatsHero backdrop', () => {
  it('follows the song that is on', () => {
    expect(backdrop({ coverUrl: 'top-album', labelUrl: 'on-now' })).toContain('on-now')
  })

  it('falls back to the top album with nothing on', () => {
    expect(backdrop({ coverUrl: 'top-album', labelUrl: null })).toContain('top-album')
  })
})

describe('StatsHero line under the bar', () => {
  it('gives way to the groove being pointed at, and comes back', async () => {
    const wrapper = mount(StatsHero, {
      props: { plays: 10 },
      global: { plugins: [vuetify, i18n], stubs: { StatsRecord: true } },
    })
    const line = wrapper.find('.stats-hero__line')
    const next = line.text()

    wrapper.findComponent(StatsRecord).vm.$emit('hover-line', 'Groove 3')
    await wrapper.vm.$nextTick()
    expect(line.text()).toBe('Groove 3')

    wrapper.findComponent(StatsRecord).vm.$emit('hover-line', '')
    await wrapper.vm.$nextTick()
    expect(line.text()).toBe(next)
  })
})
