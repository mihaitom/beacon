// The shared detail-page header: the clear logo standing in for the name,
// the subtitle/meta slots, the star/rating controls, and the artwork viewer
// hookup.
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import DetailHero from '../DetailHero.vue'

const vuetify = createVuetify({ components, directives })

function mountHero(props: Record<string, unknown> = {}, slots: Record<string, string> = {}) {
  return mount(DetailHero, {
    props: { name: 'Artist One', ...props },
    slots,
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
  })
}

describe('DetailHero', () => {
  it('shows the name as the heading when there is no logo', () => {
    const wrapper = mountHero()

    const heading = wrapper.get('h1')
    expect(heading.text()).toBe('Artist One')
    expect(heading.classes()).not.toContain('visually-hidden')
  })

  it('shows the Fanart.tv clear logo in place of the name', () => {
    const wrapper = mountHero({ logoUrl: 'https://assets.fanart.tv/logo.png' })

    const logo = wrapper.get('img.detail-hero__logo')
    expect(logo.attributes('src')).toBe('https://assets.fanart.tv/logo.png')
    expect(logo.attributes('alt')).toBe('Artist One')
    // The name stays in the document for screen readers and the outline.
    expect(wrapper.get('h1').classes()).toContain('visually-hidden')
  })

  it('renders a subtitle slot when the page supplies one', () => {
    const wrapper = mountHero({}, { subtitle: '<a href="/artists/a1">Artist One</a>' })

    expect(wrapper.get('.detail-hero__subtitle').text()).toBe('Artist One')
  })

  it('reserves the description height only when the page passes the slot', () => {
    // The artist page always passes it (so the hero never shifts when the
    // Wikipedia paragraph loads); an album does not, and must not get an
    // empty paragraph's worth of gap.
    expect(mountHero().find('.detail-hero__bio').exists()).toBe(false)
    expect(mountHero({}, { description: '<p>Bio</p>' }).find('.detail-hero__bio').exists()).toBe(
      true,
    )
  })

  it('emits the star toggle', async () => {
    const wrapper = mountHero({ starred: false, rating: 0 })

    // VRating renders its own VBtn per star, so the heart is picked out by
    // its icon rather than by being "the" button.
    const star = wrapper
      .findAllComponents({ name: 'VBtn' })
      .find((button) => String(button.props('icon')).startsWith('mdi-heart'))
    await star!.trigger('click')

    expect(wrapper.emitted('toggle-star')).toHaveLength(1)
  })

  it('opens the app-wide artwork viewer for the cover', () => {
    const emit = vi.spyOn(emitter, 'emit')
    const wrapper = mountHero({ coverArtId: 'c1' })

    ;(wrapper.vm as unknown as { showArtwork: () => void }).showArtwork()

    expect(emit).toHaveBeenCalledWith(
      'showArtwork',
      expect.objectContaining({ coverArtId: 'c1', title: 'Artist One' }),
    )
  })
})
