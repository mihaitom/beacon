import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { defineComponent } from 'vue'
import PlaylistCover from '../PlaylistCover.vue'

const vuetify = createVuetify({ components, directives })

// Stands in for CoverArt.vue: what matters here is which cover each layer
// is asked for and when it reports having loaded, which a test does by hand.
const CoverArtStub = defineComponent({
  name: 'CoverArt',
  props: { coverArtId: { type: String, default: null } },
  emits: ['loaded'],
  template: '<div class="cover-stub" />',
})

const INTERVAL = 1000

function mountCover(props: Record<string, unknown> = {}) {
  return mount(PlaylistCover, {
    props: { covers: ['a', 'b', 'c'], size: 100, intervalMs: INTERVAL, ...props },
    global: { plugins: [vuetify], stubs: { CoverArt: CoverArtStub } },
  })
}

function layers(wrapper: VueWrapper) {
  return wrapper.findAllComponents(CoverArtStub)
}

/** The cover on the visible layer. */
function shown(wrapper: VueWrapper): string | null {
  const active = layers(wrapper).find((layer) =>
    layer.classes().includes('playlist-cover__layer--active'),
  )
  return active?.props('coverArtId') ?? null
}

/** Reports every layer's current cover as arrived. */
async function loadAll(wrapper: VueWrapper) {
  for (const layer of layers(wrapper)) {
    if (layer.props('coverArtId')) layer.vm.$emit('loaded', `blob:${layer.props('coverArtId')}`)
  }
  await wrapper.vm.$nextTick()
}

async function tick(wrapper: VueWrapper) {
  vi.advanceTimersByTime(INTERVAL)
  await wrapper.vm.$nextTick()
}

let reduceMotion = false

beforeEach(() => {
  vi.useFakeTimers()
  reduceMotion = false
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce') && reduceMotion,
  }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('PlaylistCover', () => {
  it('shows the first cover and stays on it while not cycling', async () => {
    const wrapper = mountCover()
    await loadAll(wrapper)

    await tick(wrapper)
    await tick(wrapper)

    expect(shown(wrapper)).toBe('a')
  })

  it('moves on to the next cover only once it has arrived', async () => {
    const wrapper = mountCover({ cycling: true })
    await loadAll(wrapper)

    await tick(wrapper)
    expect(shown(wrapper)).toBe('a')

    await loadAll(wrapper)
    expect(shown(wrapper)).toBe('b')
  })

  it('goes round and back to the first', async () => {
    const wrapper = mountCover({ cycling: true, covers: ['a', 'b'] })
    await loadAll(wrapper)

    await tick(wrapper)
    await loadAll(wrapper)
    await tick(wrapper)
    await loadAll(wrapper)

    expect(shown(wrapper)).toBe('a')
  })

  it('passes over a cover that never arrives instead of stopping on the one before', async () => {
    const wrapper = mountCover({ cycling: true })
    await loadAll(wrapper)

    await tick(wrapper) // asks for b, which never reports back
    await tick(wrapper) // asks for c instead
    await loadAll(wrapper)

    expect(shown(wrapper)).toBe('c')
  })

  it('holds still for a reader who asked for less motion', async () => {
    reduceMotion = true
    const wrapper = mountCover({ cycling: true })
    await loadAll(wrapper)

    await tick(wrapper)
    await loadAll(wrapper)

    expect(shown(wrapper)).toBe('a')
  })

  it('starts over from the first cover of a new list', async () => {
    const wrapper = mountCover({ cycling: true })
    await loadAll(wrapper)
    await tick(wrapper)
    await loadAll(wrapper)

    await wrapper.setProps({ covers: ['x', 'y'] })
    await loadAll(wrapper)

    expect(shown(wrapper)).toBe('x')
  })

  it('reports the cover it is showing', async () => {
    const wrapper = mountCover({ cycling: true })
    await loadAll(wrapper)
    await tick(wrapper)
    await loadAll(wrapper)

    // Consecutive repeats dropped: the stub re-reports the visible layer on
    // every loadAll(), which the real CoverArt only does on a change.
    const reported = (wrapper.emitted('change') ?? []).map(([id]) => id)
    expect(reported.filter((id, i) => id !== reported[i - 1])).toEqual(['a', 'b'])
  })

  it('shows the fallback icon for a playlist with no artwork at all', () => {
    const wrapper = mountCover({ covers: [] })

    expect(layers(wrapper)).toHaveLength(1)
    expect(layers(wrapper)[0]!.props('coverArtId')).toBeNull()
  })
})
