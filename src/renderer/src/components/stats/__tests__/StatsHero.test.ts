import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
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

describe('StatsHero landing spots', () => {
  const LABEL = { x: 1, y: 2, size: 3 }
  const record = { template: '<div />', methods: { labelRect: () => LABEL } }

  function mountHero(props: Record<string, unknown>) {
    return mount(StatsHero, {
      props: { plays: 10, ...props },
      global: { plugins: [vuetify, i18n], stubs: { StatsRecord: record } },
    })
  }

  type Hero = { figureRect(figure: 'hours' | 'streak'): typeof LABEL }

  function placeAt(element: Element, left: number, top: number, height: number): void {
    element.getBoundingClientRect = () => ({ left, top, height, width: 500 }) as DOMRect
  }

  it('lands hours at the start of the title', () => {
    const wrapper = mountHero({})
    placeAt(wrapper.find('.stats-hero__title').element, 100, 200, 60)
    expect((wrapper.vm as unknown as Hero).figureRect('hours')).toEqual({
      x: 130,
      y: 230,
      size: 60,
    })
  })

  it('lands a streak on its own figure', () => {
    const wrapper = mountHero({ streak: 30 })
    const streak = wrapper.findAll('.stats-hero__figure strong').at(-1)
    placeAt(streak!.element, 400, 300, 30)
    expect((wrapper.vm as unknown as Hero).figureRect('streak')).toEqual({
      x: 415,
      y: 315,
      size: 30,
    })
  })

  it('falls back to the record when the figure is not on the page', () => {
    const wrapper = mountHero({ streak: 0 })
    expect((wrapper.vm as unknown as Hero).figureRect('streak')).toEqual(LABEL)
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

describe('StatsHero record details', () => {
  const STUBS = { StatsRecord: true, StatsShelf: true, StatsVisualizer: true }

  async function showAt(width: number) {
    let measure: () => void = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          measure = callback
        }
        observe(): void {}
        disconnect(): void {}
      },
    )
    const wrapper = mount(StatsHero, {
      props: { plays: 1000 },
      global: { plugins: [vuetify, i18n], stubs: STUBS },
    })
    Object.defineProperty(wrapper.element, 'clientWidth', { value: width })
    measure()
    await flushPromises()
    return wrapper
  }

  const shelf = (wrapper: Awaited<ReturnType<typeof showAt>>) =>
    wrapper.findComponent({ name: 'StatsShelf' })
  const display = (wrapper: Awaited<ReturnType<typeof showAt>>) =>
    wrapper.findComponent({ name: 'StatsVisualizer' })

  afterEach(() => vi.unstubAllGlobals())

  it('shows them in the display beside the records', async () => {
    const wrapper = await showAt(1300)
    display(wrapper).vm.$emit('availability', true)
    await flushPromises()
    expect(shelf(wrapper).props('inlineDetails')).toBe(true)

    shelf(wrapper).vm.$emit('detail', ['Gold record'])
    await flushPromises()

    expect(display(wrapper).props('readout')).toEqual(['Gold record'])
  })

  it('keeps the tooltips in one column', async () => {
    const wrapper = await showAt(700)
    display(wrapper).vm.$emit('availability', true)
    await flushPromises()

    expect(shelf(wrapper).props('inlineDetails')).toBe(false)
    shelf(wrapper).vm.$emit('detail', ['Gold record'])
    await flushPromises()
    expect(display(wrapper).props('readout')).toBeNull()
  })

  it('keeps the tooltips without a display', async () => {
    const wrapper = await showAt(1300)
    display(wrapper).vm.$emit('availability', false)
    await flushPromises()

    expect(shelf(wrapper).props('inlineDetails')).toBe(false)
  })
})
