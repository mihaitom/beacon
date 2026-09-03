import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import HeroBand from '../HeroBand.vue'

const vuetify = createVuetify({ components, directives })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/artists/:id', component: { template: '<div />' } },
      { path: '/albums/:id', component: { template: '<div />' } },
      { path: '/now-playing', component: { template: '<div />' } },
    ],
  })
}

let router: ReturnType<typeof makeRouter>

async function mountBand(props: Record<string, unknown> = {}) {
  router = makeRouter()
  await router.push('/')
  await router.isReady()
  return mount(HeroBand, {
    props: { greeting: 'Good evening', hasContent: true, title: 'Harbor Lights', ...props },
    global: {
      plugins: [vuetify, i18n, router],
      // Pulls in <img> loading/CORS machinery this band doesn't own.
      stubs: { CoverArt: true },
    },
  })
}

/** The Song Radio button, by its icon — the band's other button is the
 * play/pause pill. */
function radioButton(wrapper: Awaited<ReturnType<typeof mountBand>>) {
  return wrapper.find('.mdi-radio-tower')
}

describe('HeroBand', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('backdrop', () => {
    // The backdrop is the hero's own artwork, blurred — these check the
    // crossfade machinery around it, which is what makes a change of hero
    // fade rather than cut. See HeroBand.vue's backdropLayers.
    function layers(wrapper: Awaited<ReturnType<typeof mountBand>>) {
      return wrapper.findAll('.hero-backdrop').map((layer) => ({
        image: layer.attributes('style') ?? '',
        active: layer.classes().includes('hero-backdrop--active'),
      }))
    }

    it('renders the artwork on one of two stacked layers', async () => {
      const wrapper = await mountBand({ imageUrl: 'https://art/one.jpg' })

      const rendered = layers(wrapper)
      expect(rendered).toHaveLength(2)
      const active = rendered.filter((layer) => layer.active)
      expect(active).toHaveLength(1)
      expect(active[0]!.image).toContain('one.jpg')
    })

    it('moves a new artwork onto the other layer, keeping the old one to fade out of', async () => {
      const wrapper = await mountBand({ imageUrl: 'https://art/one.jpg' })
      const firstActive = layers(wrapper).findIndex((layer) => layer.active)

      await wrapper.setProps({ imageUrl: 'https://art/two.jpg' })

      const rendered = layers(wrapper)
      const nowActive = rendered.findIndex((layer) => layer.active)
      // Swapped layers rather than replacing the image in place — that's
      // what gives the opacity transition two images to blend between.
      expect(nowActive).not.toBe(firstActive)
      expect(rendered[nowActive]!.image).toContain('two.jpg')
      expect(rendered[firstActive]!.image).toContain('one.jpg')
    })

    it('paints a radio logo from what the cover reported, having no URL of its own', async () => {
      // A station logo is resolved in a batch rather than fetched from an
      // address (see radioFaviconBatch.ts), so there is nothing to blur
      // until <cover-art> says what it ended up showing.
      const wrapper = await mountBand({
        radioFavicon: { homePageUrl: 'https://station.example', hint: '', minSize: 512 },
      })
      expect(layers(wrapper).every((layer) => !layer.image.includes('url('))).toBe(true)

      wrapper.findComponent({ name: 'CoverArt' }).vm.$emit('loaded', 'blob:the-logo')
      await wrapper.vm.$nextTick()

      const active = layers(wrapper).filter((layer) => layer.active)
      expect(active).toHaveLength(1)
      expect(active[0]!.image).toContain('blob:the-logo')
    })

    it('fades the very first artwork in rather than waiting for a second one', async () => {
      // The watcher is immediate — without that, nothing would be active
      // until the hero changed once.
      const wrapper = await mountBand({ imageUrl: 'https://art/one.jpg' })

      expect(layers(wrapper).some((layer) => layer.active)).toBe(true)
    })
  })

  describe('song radio button', () => {
    it('is hidden unless the host says a radio can be built from what is shown', async () => {
      const wrapper = await mountBand()

      expect(radioButton(wrapper).exists()).toBe(false)
      // The play pill is unaffected either way.
      expect(wrapper.text()).toContain('Keep listening')
    })

    it('is shown alongside the play pill once it can, labelled rather than icon-only', async () => {
      const wrapper = await mountBand({ canStartRadio: true })

      expect(radioButton(wrapper).exists()).toBe(true)
      expect(radioButton(wrapper).element.closest('button')!.textContent).toContain('Song Radio')
    })

    it('reports the click instead of acting on it — the host owns the seed song', async () => {
      const wrapper = await mountBand({ canStartRadio: true })

      await radioButton(wrapper).element.closest('button')!.click()

      expect(wrapper.emitted('song-radio')).toHaveLength(1)
      // Not confused with the pill's own event.
      expect(wrapper.emitted('play')).toBeUndefined()
    })

    it('shows a spinner on that button while the mix is being fetched', async () => {
      const wrapper = await mountBand({ canStartRadio: true, radioLoading: true })

      const button = radioButton(wrapper).element.closest('button')!
      expect(button.classList.contains('v-btn--loading')).toBe(true)
    })

    it('stays out of the empty and loading states, which have no seed at all', async () => {
      expect(
        radioButton(await mountBand({ hasContent: false, canStartRadio: true })).exists(),
      ).toBe(false)
      expect(radioButton(await mountBand({ loading: true, canStartRadio: true })).exists()).toBe(
        false,
      )
    })
  })
})

describe('HeroBand artwork click', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('opens Now Playing when the artwork is of something actually playing', async () => {
    const wrapper = await mountBand({ coverTo: '/now-playing' })

    await wrapper.find('.hero-cover').trigger('click')
    // router.push resolves asynchronously — isReady() only covers the
    // *initial* navigation and would pass before this one has landed.
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/now-playing')
    // Navigating instead of starting playback — the artwork is a picture
    // of what is already playing, and the play/pause pill next to it is
    // still the way to stop or restart it.
    expect(wrapper.emitted('play')).toBeUndefined()
  })

  it('still plays when there is nothing playing to navigate to', async () => {
    // The "nothing playing, here's your most recent album" state: the
    // artwork is a suggestion, and Now Playing would have nothing to show.
    const wrapper = await mountBand()

    await wrapper.find('.hero-cover').trigger('click')

    expect(wrapper.emitted('play')).toHaveLength(1)
    expect(router.currentRoute.value.path).toBe('/')
  })
})
