import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import StatsHero from '../StatsHero.vue'

const vuetify = createVuetify({ components, directives })
const STUBS = { StatsRecord: true, StatsShelf: true, StatsVisualizer: true }
let wrapper: VueWrapper<InstanceType<typeof StatsHero>>
let host: HTMLElement

function show(width: number, props: Record<string, unknown> = {}): void {
  host.style.width = `${width}px`
  wrapper = mount(StatsHero, {
    attachTo: host,
    props: { plays: 13503, listeningSeconds: 50 * 86400, streak: 34, ...props },
    global: { plugins: [vuetify, i18n], stubs: STUBS },
  })
}

function columnWidth(): number {
  return wrapper.find('.stats-hero__column').element.getBoundingClientRect().width
}

async function reveal(amount: number): Promise<void> {
  wrapper.vm.reveal = amount
  await nextTick()
}

beforeEach(() => {
  setActivePinia(createPinia())
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  wrapper.unmount()
  host.remove()
})

describe('the width of the hero text', () => {
  it('does not move while the title counts up', async () => {
    show(3400, { listeningSeconds: 123456 * 86400 })
    await reveal(0)
    const counting = columnWidth()

    await reveal(1)

    expect(columnWidth()).toBeCloseTo(counting, 1)
  })

  it('wraps a long sentence instead of growing with it', async () => {
    show(3400)
    await nextTick()
    const before = columnWidth()

    await wrapper.setProps({ line: 'A sentence that runs on. '.repeat(12) })

    expect(columnWidth()).toBeCloseTo(before, 1)
  })

  it('stays inside the card on a phone', async () => {
    show(360)
    await nextTick()

    expect(columnWidth()).toBeLessThanOrEqual(360)
  })
})
