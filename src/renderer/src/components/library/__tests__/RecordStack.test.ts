import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import RecordStack from '../RecordStack.vue'

const vuetify = createVuetify({ components, directives })

function mountStack(props: Record<string, unknown>) {
  return mount(RecordStack, {
    props: { size: 100, ...props },
    global: { plugins: [vuetify], stubs: { CoverArt: true } },
  })
}

/** The covers on show, front first. */
const shown = (wrapper: ReturnType<typeof mountStack>) =>
  wrapper
    .findAll('.record-stack__record')
    .filter((record) => !record.classes().some((c) => c.startsWith('record-leave')))
    .map((record) => record.findComponent({ name: 'CoverArt' }).props('coverArtId'))

describe('RecordStack', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('stands its covers front first, filling the back with empty sleeves', () => {
    expect(shown(mountStack({ covers: ['a', 'b'], depth: 4 }))).toEqual(['a', 'b', null, null])
  })

  it('stays still until it is browsed', async () => {
    const wrapper = mountStack({ covers: ['a', 'b', 'c', 'd', 'e'], depth: 3 })

    await vi.advanceTimersByTimeAsync(5000)

    expect(shown(wrapper)).toEqual(['a', 'b', 'c'])
  })

  it('pulls the front record and brings in the next at the back while browsed', async () => {
    const wrapper = mountStack({ covers: ['a', 'b', 'c', 'd', 'e'], depth: 3, browsing: true })

    await vi.advanceTimersByTimeAsync(400)
    expect(shown(wrapper)).toEqual(['b', 'c', 'd'])
    expect(wrapper.emitted('change')?.at(-1)).toEqual(['b'])

    await vi.advanceTimersByTimeAsync(1100)
    expect(shown(wrapper)).toEqual(['c', 'd', 'e'])
  })

  it('comes round again once every cover has been at the front', async () => {
    const wrapper = mountStack({ covers: ['a', 'b'], depth: 3, browsing: true })

    await vi.advanceTimersByTimeAsync(400)

    expect(shown(wrapper)).toEqual(['b', 'a', 'b'])
  })

  it('stops where it is when the pointer leaves', async () => {
    const wrapper = mountStack({ covers: ['a', 'b', 'c', 'd'], depth: 2, browsing: true })
    await vi.advanceTimersByTimeAsync(400)

    await wrapper.setProps({ browsing: false })
    await vi.advanceTimersByTimeAsync(5000)

    expect(shown(wrapper)).toEqual(['b', 'c'])
  })

  it('does not flip a single cover, or for someone who asked for less motion', async () => {
    const single = mountStack({ covers: ['a'], depth: 2, browsing: true })
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const still = mountStack({ covers: ['a', 'b', 'c'], depth: 2, browsing: true })

    await vi.advanceTimersByTimeAsync(3000)

    expect(shown(single)).toEqual(['a', null])
    expect(shown(still)).toEqual(['a', 'b'])
    vi.unstubAllGlobals()
  })
})
