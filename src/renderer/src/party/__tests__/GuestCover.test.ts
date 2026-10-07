import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import GuestCover from '../components/GuestCover.vue'

const vuetify = createVuetify({ components, directives })

function mountCover(props: Record<string, unknown>) {
  return mount(GuestCover, { props, global: { plugins: [vuetify] } })
}

describe('GuestCover', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the fallback icon for a song without a cover', () => {
    const wrapper = mountCover({ src: null, size: 300 })

    expect(wrapper.find('.cover-art-fallback').exists()).toBe(true)
  })

  it('falls back to the icon when the cover fails to load', async () => {
    const wrapper = mountCover({ src: '/party/api/cover?id=gone', size: 300 })
    expect(wrapper.find('.cover-art-fallback').exists()).toBe(false)

    wrapper.findComponent({ name: 'VImg' }).vm.$emit('error')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.cover-art-fallback').exists()).toBe(true)
  })

  it("reports a station logo's transparency from connect's reading", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { 'X-Has-Transparency': 'true' } }))
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountCover({ src: '/party/api/radio-logo', contain: true })
    await flushPromises()

    expect(wrapper.emitted('transparency')).toEqual([[true]])
  })

  it('does not ask about a song cover', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    mountCover({ src: '/party/api/cover?id=c1' })

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
