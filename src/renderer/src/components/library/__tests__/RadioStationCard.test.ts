import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import RadioStationCard from '../RadioStationCard.vue'
import type { RadioStation } from '@/types/library'

const vuetify = createVuetify({ components, directives })

function makeStation(overrides: Partial<RadioStation> = {}): RadioStation {
  return {
    id: 's1',
    name: 'Chill FM',
    streamUrl: 'https://stream.example.com/chill.mp3',
    homePageUrl: 'https://www.chillfm.example',
    ...overrides,
  }
}

function mountCard(props: Partial<InstanceType<typeof RadioStationCard>['$props']> = {}) {
  return mount(RadioStationCard, {
    props: { station: makeStation(), ...props },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
    // v-menu teleports its content out of the component tree.
    attachTo: document.body,
  })
}

describe('RadioStationCard', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('plays the station when the card is clicked', async () => {
    const wrapper = mountCard()

    await wrapper.get('.radio-tile').trigger('click')

    expect(wrapper.emitted('play')).toEqual([[wrapper.props('station')]])
  })

  it('shows the homepage host as the caption, without the www prefix', () => {
    const wrapper = mountCard()

    expect(wrapper.text()).toContain('chillfm.example')
    expect(wrapper.text()).not.toContain('www.chillfm.example')
    expect(wrapper.text()).not.toContain('stream.example.com')
  })

  it('falls back to the stream URL host when the station has no homepage', () => {
    const wrapper = mountCard({ station: makeStation({ homePageUrl: null }) })

    expect(wrapper.text()).toContain('stream.example.com')
  })

  it('shows no caption for a malformed URL instead of the raw garbage', () => {
    const wrapper = mountCard({
      station: makeStation({ homePageUrl: null, streamUrl: 'not a url' }),
    })

    expect(wrapper.text()).not.toContain('not a url')
  })

  it('opens an edit/delete menu without also playing the station', async () => {
    const wrapper = mountCard()

    await wrapper.get('.radio-tile__menu').trigger('click')
    expect(wrapper.emitted('play')).toBeUndefined()

    const editItem = [...document.querySelectorAll('.v-list-item')].find((el) =>
      el.textContent?.includes('Edit'),
    ) as HTMLElement
    editItem.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('edit')).toEqual([[wrapper.props('station')]])
  })

  it('emits delete from the same menu', async () => {
    const wrapper = mountCard()

    await wrapper.get('.radio-tile__menu').trigger('click')
    const deleteItem = [...document.querySelectorAll('.v-list-item')].find((el) =>
      el.textContent?.includes('Delete'),
    ) as HTMLElement
    deleteItem.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('delete')).toEqual([[wrapper.props('station')]])
  })

  it('highlights the tile and pins the cover overlay with a volume icon while this station is current', async () => {
    const notPlaying = mountCard()
    expect(notPlaying.find('.radio-tile--current').exists()).toBe(false)
    expect(notPlaying.find('.radio-tile__cover-overlay--current').exists()).toBe(false)
    expect(notPlaying.find('.mdi-play').exists()).toBe(true)

    const station = makeStation()
    const playing = mountCard({ station })
    usePlaybackStore().radioStation = { ...station }
    await playing.vm.$nextTick()

    expect(playing.find('.radio-tile--current').exists()).toBe(true)
    expect(playing.find('.radio-tile__cover-overlay--current').exists()).toBe(true)
    expect(playing.find('.mdi-volume-high').exists()).toBe(true)
  })
})
