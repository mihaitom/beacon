// Real-browser test: which decade names show is decided by container queries
// on each column, which jsdom does not lay out.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import StatsCollection from '../StatsCollection.vue'

const vuetify = createVuetify({ components, directives })
const decades = Array.from({ length: 11 }, (_, index) => {
  const label = `${1880 + index * 10 + (index > 1 ? 20 : 0)}s`
  return { id: label, label, value: index + 1, valueLabel: String(index + 1) }
})

let wrapper: VueWrapper | null = null
let host: HTMLElement | null = null

async function namesAt(width: number): Promise<DOMRect[]> {
  host = document.createElement('div')
  host.style.width = `${width}px`
  document.body.append(host)
  wrapper = mount(StatsCollection, {
    attachTo: host,
    props: { facts: [], decades },
    global: { plugins: [vuetify, i18n] },
  })
  await wrapper.vm.$nextTick()
  return wrapper
    .findAll<HTMLElement>('.stats-collection__decade em')
    .filter((name) => getComputedStyle(name.element).visibility === 'visible')
    .map((name) => name.element.getBoundingClientRect())
}

afterEach(() => {
  wrapper?.unmount()
  host?.remove()
})

describe('the decade names', () => {
  it('are all there when the panel has the room', async () => {
    expect(await namesAt(1300)).toHaveLength(decades.length)
  })

  it('give way rather than run into each other', async () => {
    const names = await namesAt(300)
    expect(names.length).toBeLessThan(decades.length)
    names.slice(1).forEach((name, index) => {
      expect(name.left).toBeGreaterThanOrEqual((names[index] as DOMRect).right)
    })
  })
})
