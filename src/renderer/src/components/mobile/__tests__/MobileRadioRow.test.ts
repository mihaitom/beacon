import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import MobileRadioRow from '../MobileRadioRow.vue'
import type { RadioStation } from '@/types/library'

const vuetify = createVuetify({ components, directives })

function makeStation(overrides: Partial<RadioStation> = {}): RadioStation {
  return {
    id: 'r1',
    name: 'Chill FM',
    streamUrl: 'https://cdn.streamprovider.example/chill',
    homePageUrl: 'https://www.chill.example',
    ...overrides,
  } as RadioStation
}

function mountRow(station = makeStation()) {
  return mount(MobileRadioRow, {
    props: { station },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true, TileContextMenu: true } },
  })
}

describe('MobileRadioRow', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('plays the station when the row is tapped', async () => {
    const wrapper = mountRow()

    await wrapper.get('.radio-row').trigger('click')

    expect(wrapper.emitted('play')?.[0]?.[0]).toMatchObject({ id: 'r1' })
  })

  /** The stream host is usually a faceless CDN; the homepage is the
   * station's own recognisable domain — same choice RadioStationCard makes. */
  it('captions the station with its homepage host, www stripped', () => {
    const wrapper = mountRow()

    expect(wrapper.get('.radio-row__host').text()).toBe('chill.example')
  })

  it('falls back to the stream host when there is no homepage', () => {
    const wrapper = mountRow(makeStation({ homePageUrl: null }))

    expect(wrapper.get('.radio-row__host').text()).toBe('cdn.streamprovider.example')
  })

  it('shows no caption at all for an unparseable saved URL', () => {
    const wrapper = mountRow(makeStation({ homePageUrl: null, streamUrl: 'not a url' }))

    expect(wrapper.find('.radio-row__host').exists()).toBe(false)
  })

  /** Marked by id rather than stream URL: a station edited to a new URL is
   * still the one playing. */
  it('marks the station that is playing', async () => {
    const wrapper = mountRow()
    expect(wrapper.get('.radio-row').classes()).not.toContain('radio-row--current')

    usePlaybackStore().radioStation = makeStation({
      streamUrl: 'https://cdn.streamprovider.example/moved',
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.radio-row').classes()).toContain('radio-row--current')
  })

  /** The one thing the remote's own list has no equivalent for: with no
   * hover on a phone, edit and delete have to be a plain tap away. */
  it('opens its menu from the button without also playing', async () => {
    const opened: unknown[] = []
    // A real stub with the one method the row calls on the ref — assigning
    // to $refs after mount would not work, Vue owns that object and the
    // template's handler is bound to the component instance, not to
    // whatever is put there afterwards.
    const wrapper = mount(MobileRadioRow, {
      props: { station: makeStation() },
      global: {
        plugins: [vuetify, i18n],
        stubs: {
          CoverArt: true,
          TileContextMenu: {
            template: '<div />',
            methods: {
              open(event: MouseEvent) {
                opened.push(event)
              },
            },
          },
        },
      },
    })

    await wrapper.get('.radio-row__menu').trigger('click')

    expect(opened).toHaveLength(1)
    // @click.stop on the button — a tap meant for the menu must not also
    // start the station underneath it.
    expect(wrapper.emitted('play')).toBeUndefined()
  })
})
