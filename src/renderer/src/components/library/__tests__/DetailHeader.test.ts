// The album/artist/genre/playlist page header. Only its backdrop is
// covered here — that's the part with logic (a crossfade between two
// stacked layers, see services/crossfadeBackdrop.ts); the rest of this
// component is presentational markup driven straight from its props.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import DetailHeader from '../DetailHeader.vue'
import RecordStack from '../RecordStack.vue'
import { emitter } from '@/emitter'

const vuetify = createVuetify({ components, directives })

function mountHeader(props: Record<string, unknown> = {}) {
  return mount(DetailHeader, {
    props: { title: 'Slow Return', ...props },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
  })
}

function layers(wrapper: ReturnType<typeof mountHeader>) {
  return wrapper.findAll('.detail-header__backdrop').map((layer) => ({
    image: layer.attributes('style') ?? '',
    active: layer.classes().includes('detail-header__backdrop--active'),
  }))
}

describe('DetailHeader backdrop', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows the artwork on one of two stacked layers', () => {
    const wrapper = mountHeader({ imageUrl: 'https://art/one.jpg' })

    const rendered = layers(wrapper)
    expect(rendered).toHaveLength(2)
    expect(rendered.filter((layer) => layer.active)).toHaveLength(1)
    expect(rendered.find((layer) => layer.active)!.image).toContain('one.jpg')
  })

  it('keeps the previous artwork around when navigating to another item', async () => {
    // Regression: this used to bind the image to a single element, so
    // going from one album to the next cut straight to the new artwork the
    // moment it loaded instead of fading.
    const wrapper = mountHeader({ imageUrl: 'https://art/one.jpg' })
    const firstActive = layers(wrapper).findIndex((layer) => layer.active)

    await wrapper.setProps({ imageUrl: 'https://art/two.jpg' })

    const rendered = layers(wrapper)
    const nowActive = rendered.findIndex((layer) => layer.active)
    expect(nowActive).not.toBe(firstActive)
    expect(rendered[nowActive]!.image).toContain('two.jpg')
    // Both images on screen at once is what gives the transition something
    // to blend between.
    expect(rendered[firstActive]!.image).toContain('one.jpg')
  })

  it('fades in the very first artwork rather than waiting for a second one', () => {
    const wrapper = mountHeader({ imageUrl: 'https://art/one.jpg' })

    expect(layers(wrapper).some((layer) => layer.active)).toBe(true)
  })

  it('renders empty layers for an item with no artwork at all', () => {
    const wrapper = mountHeader()

    expect(layers(wrapper)).toHaveLength(2)
    expect(layers(wrapper).every((layer) => !layer.image.includes('url('))).toBe(true)
  })
})

describe('DetailHeader record stack', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const stack = (wrapper: ReturnType<typeof mountHeader>) => wrapper.findComponent(RecordStack)
  const art = (wrapper: ReturnType<typeof mountHeader>) => wrapper.find('.detail-header__cover')

  it('flips through while pointed at, and only then', async () => {
    const wrapper = mountHeader({ recordStack: ['a', 'b'] })
    expect(stack(wrapper).props('browsing')).toBe(false)

    await art(wrapper).trigger('mouseenter')
    expect(stack(wrapper).props('browsing')).toBe(true)

    await art(wrapper).trigger('mouseleave')
    expect(stack(wrapper).props('browsing')).toBe(false)
  })

  it('opens the record that is at the front', async () => {
    const shown = vi.fn()
    emitter.on('showArtwork', shown)
    const wrapper = mountHeader({ recordStack: ['a', 'b'], coverArtId: 'mosaic' })

    await art(wrapper).trigger('click')
    expect(shown.mock.lastCall![0]).toMatchObject({ coverArtId: 'a' })

    stack(wrapper).vm.$emit('change', 'b')
    await art(wrapper).trigger('click')
    expect(shown.mock.lastCall![0]).toMatchObject({ coverArtId: 'b' })
    emitter.off('showArtwork', shown)
  })

  it('has nothing to open on an empty stack', async () => {
    const shown = vi.fn()
    emitter.on('showArtwork', shown)
    const wrapper = mountHeader({ recordStack: [] })

    await art(wrapper).trigger('click')

    expect(shown).not.toHaveBeenCalled()
    emitter.off('showArtwork', shown)
  })
})
