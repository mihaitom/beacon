// The artist page's own header: the clear logo standing in for the name,
// the star/rating controls, and the artwork viewer hookup.
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import ArtistHero from '../ArtistHero.vue'

const vuetify = createVuetify({ components, directives })

function mountHero(props: Record<string, unknown> = {}) {
  return mount(ArtistHero, {
    props: { name: 'Artist One', ...props },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
  })
}

describe('ArtistHero', () => {
  it('shows the name as the heading when there is no logo', () => {
    const wrapper = mountHero()

    const heading = wrapper.get('h1')
    expect(heading.text()).toBe('Artist One')
    expect(heading.classes()).not.toContain('visually-hidden')
  })

  it('shows the Fanart.tv clear logo in place of the name', () => {
    const wrapper = mountHero({ logoUrl: 'https://assets.fanart.tv/logo.png' })

    const logo = wrapper.get('img.artist-hero__logo')
    expect(logo.attributes('src')).toBe('https://assets.fanart.tv/logo.png')
    expect(logo.attributes('alt')).toBe('Artist One')
    // The name stays in the document for screen readers and the outline.
    expect(wrapper.get('h1').classes()).toContain('visually-hidden')
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
