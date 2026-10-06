import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { usePlaybackStore } from '@/stores/playback'
import RadioStationRow from '../RadioStationRow.vue'
import { useRadioStationInfoStore } from '@/stores/radioStationInfo'
import { useRadioMetadataStore } from '@/stores/radioMetadata'
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

function mountRow(props: Partial<InstanceType<typeof RadioStationRow>['$props']> = {}) {
  return mount(RadioStationRow, {
    props: { station: makeStation(), ...props },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
    // v-menu teleports its content out of the component tree.
    attachTo: document.body,
  })
}

describe('RadioStationRow', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  /** Same rule the phone's row follows: Navidrome's own `adminOnly` group
   * covers update/deleteInternetRadioStation, so for anyone else the menu
   * offered two operations the server would refuse. Playing is untouched. */
  it('drops the edit/delete menu for an account the server refuses those from', async () => {
    useAuthStore().$patch({ serverType: 'subsonic', isAdmin: false })
    const wrapper = mountRow()

    expect(wrapper.find('.radio-row__menu').exists()).toBe(false)

    await wrapper.get('.radio-row').trigger('click')
    expect(wrapper.emitted('play')?.[0]?.[0]).toMatchObject({ id: 's1' })
  })

  it('plays the station when the row is clicked', async () => {
    const wrapper = mountRow()

    await wrapper.get('.radio-row').trigger('click')

    expect(wrapper.emitted('play')).toEqual([[wrapper.props('station')]])
  })

  /** A station added from the discover dialog carries Radio Browser's own
   * favicon URL and may have no homepage at all — asking only when there is
   * a homepage left exactly those stations without a logo here, while the
   * player bar showed one. */
  describe('the station logo', () => {
    function faviconOf(wrapper: ReturnType<typeof mountRow>) {
      return wrapper.findComponent({ name: 'CoverArt' }).props('radioFavicon') as {
        homePageUrl: string
        hint: string
      } | null
    }

    it('is looked up from the homepage and the discover hint together', () => {
      const wrapper = mountRow({
        station: makeStation({ favicon: 'https://cdn.example/logo.png' }),
      })

      expect(faviconOf(wrapper)).toMatchObject({
        homePageUrl: 'https://www.chillfm.example',
        hint: 'https://cdn.example/logo.png',
      })
    })

    it('is still looked up for a station that has only the hint', () => {
      const wrapper = mountRow({
        station: makeStation({ homePageUrl: null, favicon: 'https://cdn.example/logo.png' }),
      })

      expect(faviconOf(wrapper)).toMatchObject({ hint: 'https://cdn.example/logo.png' })
    })

    it('is not asked for at all when there is nothing to look one up with', () => {
      const wrapper = mountRow({ station: makeStation({ homePageUrl: null }) })

      expect(faviconOf(wrapper)).toBeNull()
    })
  })

  it('shows the homepage host as the caption, without the www prefix', () => {
    const wrapper = mountRow()

    expect(wrapper.text()).toContain('chillfm.example')
    expect(wrapper.text()).not.toContain('www.chillfm.example')
    expect(wrapper.text()).not.toContain('stream.example.com')
  })

  it('falls back to the stream URL host when the station has no homepage', () => {
    const wrapper = mountRow({ station: makeStation({ homePageUrl: null }) })

    expect(wrapper.text()).toContain('stream.example.com')
  })

  it('shows no caption for a malformed URL instead of the raw garbage', () => {
    const wrapper = mountRow({
      station: makeStation({ homePageUrl: null, streamUrl: 'not a url' }),
    })

    expect(wrapper.text()).not.toContain('not a url')
  })

  it('opens an edit/delete menu without also playing the station', async () => {
    const wrapper = mountRow()

    await wrapper.get('.radio-row__menu').trigger('click')
    expect(wrapper.emitted('play')).toBeUndefined()

    const editItem = [...document.querySelectorAll('.v-list-item')].find((el) =>
      el.textContent?.includes('Edit'),
    ) as HTMLElement
    editItem.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('edit')).toEqual([[wrapper.props('station')]])
  })

  it('emits delete from the same menu', async () => {
    const wrapper = mountRow()

    await wrapper.get('.radio-row__menu').trigger('click')
    const deleteItem = [...document.querySelectorAll('.v-list-item')].find((el) =>
      el.textContent?.includes('Delete'),
    ) as HTMLElement
    deleteItem.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('delete')).toEqual([[wrapper.props('station')]])
  })

  it('highlights the row and pins the logo overlay with a volume icon while this station is current', async () => {
    const notPlaying = mountRow()
    expect(notPlaying.find('.radio-row--current').exists()).toBe(false)
    expect(notPlaying.find('.radio-row__logo-overlay--current').exists()).toBe(false)
    expect(notPlaying.find('.mdi-play').exists()).toBe(true)

    const station = makeStation()
    const playing = mountRow({ station })
    usePlaybackStore().radioStation = { ...station }
    await playing.vm.$nextTick()

    expect(playing.find('.radio-row--current').exists()).toBe(true)
    expect(playing.find('.radio-row__logo-overlay--current').exists()).toBe(true)
    expect(playing.find('.mdi-volume-high').exists()).toBe(true)
  })

  it('plays from its play button, once', async () => {
    const wrapper = mountRow()

    await wrapper.get('.radio-row__actions .mdi-play').element.closest('button')!.click()

    expect(wrapper.emitted('play')).toEqual([[wrapper.props('station')]])
  })

  describe('the details under the name', () => {
    const at = (iso: string) => Date.parse(iso) / 1000

    it("shows the directory's country, format and tags", async () => {
      useRadioStationInfoStore().byUrl = {
        'https://stream.example.com/chill.mp3': {
          tags: ['chillout', 'lounge'],
          country: 'Germany',
          codec: 'MP3',
          bitrate: 128,
          lastTitle: null,
        },
      }
      const wrapper = mountRow()

      expect(wrapper.text()).toContain('chillfm.example · Germany · MP3 128 kbit/s')
      const chips = wrapper.findAllComponents({ name: 'VChip' }).map((chip) => chip.text())
      expect(chips).toEqual(['chillout', 'lounge'])
    })

    it('names the last title heard on the station, and when', async () => {
      vi.useFakeTimers({ now: Date.parse('2026-10-06T12:00:00Z'), toFake: ['Date'] })
      useRadioStationInfoStore().byUrl = {
        'https://stream.example.com/chill.mp3': {
          lastTitle: { title: "Air - La Femme d'Argent", at: at('2026-10-04T12:00:00Z') },
        },
      }
      const wrapper = mountRow()
      vi.useRealTimers()

      expect(wrapper.text()).toContain("Last heard: Air - La Femme d'Argent · 2 days ago")
    })

    it('says what is on now for the station that is playing instead', async () => {
      useRadioStationInfoStore().byUrl = {
        'https://stream.example.com/chill.mp3': {
          lastTitle: { title: 'Old - Song', at: at('2026-10-04T12:00:00Z') },
        },
      }
      const station = makeStation()
      usePlaybackStore().radioStation = { ...station }
      useRadioMetadataStore().nowPlaying = 'Moby - Porcelain'
      const wrapper = mountRow({ station })

      expect(wrapper.text()).toContain('Now playing: Moby - Porcelain')
      expect(wrapper.text()).not.toContain('Old - Song')
    })
  })
})
