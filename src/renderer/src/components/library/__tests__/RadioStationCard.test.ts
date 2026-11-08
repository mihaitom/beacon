import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { usePlaybackStore } from '@/stores/playback'
import RadioStationCard from '../RadioStationCard.vue'
import { useRadioStationInfoStore } from '@/stores/radioStationInfo'
import { useRadioMetadataStore } from '@/stores/radioMetadata'
import { extractDominantColor } from '@/services/colorExtractor'
import { readLogoLook } from '@/services/stationLogo'
import type { RadioStation } from '@/types/library'

vi.mock('@/services/stationLogo', () => ({ readLogoLook: vi.fn() }))
vi.mock('@/services/colorExtractor', () => ({ extractDominantColor: vi.fn() }))

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

function mountRow(props: Partial<InstanceType<typeof RadioStationCard>['$props']> = {}) {
  return mount(RadioStationCard, {
    props: { station: makeStation(), row: true, ...props },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
    // v-menu teleports its content out of the component tree.
    attachTo: document.body,
  })
}

describe('RadioStationCard', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(readLogoLook).mockReset().mockResolvedValue(null)
    vi.mocked(extractDominantColor).mockReset().mockResolvedValue(null)
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

    expect(wrapper.find('.radio-card__menu').exists()).toBe(false)

    await wrapper.get('.radio-card').trigger('click')
    expect(wrapper.emitted('play')?.[0]?.[0]).toMatchObject({ id: 's1' })
  })

  it('plays the station when the row is clicked', async () => {
    const wrapper = mountRow()

    await wrapper.get('.radio-card').trigger('click')

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

    await wrapper.get('.radio-card__menu').trigger('click')
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

    await wrapper.get('.radio-card__menu').trigger('click')
    const deleteItem = [...document.querySelectorAll('.v-list-item')].find((el) =>
      el.textContent?.includes('Delete'),
    ) as HTMLElement
    deleteItem.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('delete')).toEqual([[wrapper.props('station')]])
  })

  describe('the station that is on', () => {
    function mountCurrent(isPlaying: boolean) {
      const station = makeStation()
      const playback = usePlaybackStore()
      playback.radioStation = { ...station }
      playback.isPlaying = isPlaying
      return mountRow({ station })
    }

    it('is marked and offers to stop', () => {
      const wrapper = mountCurrent(true)

      expect(wrapper.find('.radio-card--current').exists()).toBe(true)
      expect(wrapper.find('.radio-card__bars').exists()).toBe(true)
      expect(wrapper.find('.radio-card__actions .mdi-stop').exists()).toBe(true)
    })

    /** Paused it is still the current station, but nothing is on air, and
     * a stop button would have nothing to stop. */
    it('offers to play again while paused', () => {
      const wrapper = mountCurrent(false)

      expect(wrapper.find('.radio-card--current').exists()).toBe(true)
      expect(wrapper.find('.radio-card__bars').exists()).toBe(false)
      expect(wrapper.find('.radio-card__actions .mdi-play').exists()).toBe(true)
    })

    it('does not mark any other station', () => {
      usePlaybackStore().radioStation = makeStation({ id: 'other' })
      usePlaybackStore().isPlaying = true
      const wrapper = mountRow()

      expect(wrapper.find('.radio-card--current').exists()).toBe(false)
      expect(wrapper.find('.radio-card__bars').exists()).toBe(false)
    })
  })

  it('plays from its play button, once', async () => {
    const wrapper = mountRow()

    await wrapper.get('.radio-card__actions .mdi-play').element.closest('button')!.click()

    expect(wrapper.emitted('play')).toEqual([[wrapper.props('station')]])
  })

  describe('as a tile', () => {
    function logoOf(wrapper: ReturnType<typeof mountRow>) {
      return wrapper.findComponent({ name: 'CoverArt' })
    }

    async function loadLogo(wrapper: ReturnType<typeof mountRow>, src: string) {
      logoOf(wrapper).vm.$emit('loaded', src)
      await flushPromises()
    }

    it('plays from the button on the sleeve, once', async () => {
      const wrapper = mountRow({ row: false })

      await wrapper.get('.radio-card__play').trigger('click')

      expect(wrapper.emitted('play')).toEqual([[wrapper.props('station')]])
    })

    it('opens the menu from the sleeve without playing', async () => {
      const wrapper = mountRow({ row: false })

      await wrapper.get('.radio-card__menu').trigger('click')

      expect(wrapper.emitted('play')).toBeUndefined()
      expect(document.body.textContent).toContain('Edit')
    })

    it("puts the logo on a sleeve of the logo's own colour", async () => {
      vi.mocked(readLogoLook).mockResolvedValue({ sleeve: [200, 10, 20], pixels: 512 })
      const wrapper = mountRow({ row: false })

      await loadLogo(wrapper, 'blob:logo')

      const sleeve = wrapper.get('.radio-card__sleeve').element as HTMLElement
      expect(sleeve.style.backgroundColor).toBe('rgb(200, 10, 20)')
    })

    it('does not enlarge a small favicon past what it can carry', async () => {
      vi.mocked(readLogoLook).mockResolvedValue({ sleeve: null, pixels: 48 })
      const wrapper = mountRow({ row: false })

      await loadLogo(wrapper, 'blob:favicon')

      expect(logoOf(wrapper).props('size')).toContain('96px')
    })

    /** Logos arrive in batches and a reused card changes station, so a slow
     * read of the old logo can finish after the new one. */
    it('ignores the look of a logo that has been replaced meanwhile', async () => {
      let finishOld: (look: { sleeve: [number, number, number]; pixels: number }) => void
      vi.mocked(readLogoLook)
        .mockReturnValueOnce(new Promise((resolve) => (finishOld = resolve)))
        .mockResolvedValueOnce({ sleeve: [1, 2, 3], pixels: 512 })
      const wrapper = mountRow({ row: false })

      await loadLogo(wrapper, 'blob:old')
      await loadLogo(wrapper, 'blob:new')
      finishOld!({ sleeve: [9, 9, 9], pixels: 512 })
      await flushPromises()

      const sleeve = wrapper.get('.radio-card__sleeve').element as HTMLElement
      expect(sleeve.style.backgroundColor).toBe('rgb(1, 2, 3)')
    })

    it('reads the glow colour only once the card is pointed at', async () => {
      vi.mocked(extractDominantColor).mockResolvedValue([40, 50, 60])
      const wrapper = mountRow({ row: false })
      await loadLogo(wrapper, 'blob:logo')
      expect(extractDominantColor).not.toHaveBeenCalled()

      await wrapper.get('.radio-card').trigger('mouseenter')
      await flushPromises()

      expect(extractDominantColor).toHaveBeenCalledWith('blob:logo')
      const glow = wrapper.get('.radio-card__glow').element as HTMLElement
      expect(glow.style.backgroundColor).toBe('rgb(40, 50, 60)')
    })

    it('glows for the station that is on without being pointed at', async () => {
      const station = makeStation()
      usePlaybackStore().radioStation = { ...station }
      const wrapper = mountRow({ row: false, station })

      await loadLogo(wrapper, 'blob:logo')

      expect(extractDominantColor).toHaveBeenCalledWith('blob:logo')
    })

    it('gives the caption to country and format once those are known', () => {
      useRadioStationInfoStore().byUrl = {
        'https://stream.example.com/chill.mp3': { country: 'Germany', lastTitle: null },
      }
      const wrapper = mountRow({ row: false })

      expect(wrapper.text()).toContain('Germany')
      expect(wrapper.text()).not.toContain('chillfm.example')
    })

    it('still names the host while nothing else is known', () => {
      const wrapper = mountRow({ row: false })

      expect(wrapper.text()).toContain('chillfm.example')
    })
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
