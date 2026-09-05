import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import CenterControls from '../CenterControls.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function mountControls() {
  return mount(CenterControls, { global: { plugins: [vuetify, i18n] } })
}

describe('CenterControls', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('disables previous/play/next with nothing playing', () => {
    const wrapper = mountControls()

    const playBtn = wrapper.get('.play-btn')
    expect(playBtn.attributes('disabled')).not.toBeUndefined()
    expect(
      wrapper.get('.mdi-skip-previous').element.closest('button')!.hasAttribute('disabled'),
    ).toBe(true)
    expect(wrapper.get('.mdi-skip-next').element.closest('button')!.hasAttribute('disabled')).toBe(
      true,
    )
  })

  describe('a song is playing', () => {
    function mountWithSong(songs = [makeSong('a', { title: 'Track A' })]) {
      const wrapper = mountControls()
      usePlaybackStore().setQueue(songs, 0)
      return wrapper
    }

    it('play/pause button reflects isPlaying and toggles playback on click', async () => {
      const wrapper = mountWithSong()
      await wrapper.vm.$nextTick()
      const playback = usePlaybackStore()
      const toggleSpy = vi.spyOn(playback, 'togglePlay').mockResolvedValue()

      const playBtn = wrapper.get('.play-btn')
      expect(playBtn.attributes('disabled')).toBeUndefined()
      expect(playBtn.find('.mdi-play').exists()).toBe(true)

      await playBtn.trigger('click')

      expect(toggleSpy).toHaveBeenCalledOnce()
    })

    it('skip-next is disabled without a next song and enabled with one', async () => {
      const wrapper = mountWithSong()
      await wrapper.vm.$nextTick()
      const nextBtn = wrapper.get('.mdi-skip-next').element.closest('button')!

      // hasNext is false with a single-song queue and repeat off.
      expect(nextBtn.hasAttribute('disabled')).toBe(true)

      usePlaybackStore().setQueue(
        [makeSong('a', { title: 'Track A' }), makeSong('b', { title: 'Track B' })],
        0,
      )
      await wrapper.vm.$nextTick()

      expect(nextBtn.hasAttribute('disabled')).toBe(false)
    })

    it('calls playPrevious/playNext from the transport buttons', async () => {
      const wrapper = mountWithSong([makeSong('a'), makeSong('b')])
      await wrapper.vm.$nextTick()
      const playback = usePlaybackStore()
      const prevSpy = vi.spyOn(playback, 'playPrevious').mockResolvedValue()
      const nextSpy = vi.spyOn(playback, 'playNext').mockResolvedValue()

      await wrapper.get('.mdi-skip-previous').trigger('click')
      await wrapper.get('.mdi-skip-next').trigger('click')

      expect(prevSpy).toHaveBeenCalledOnce()
      expect(nextSpy).toHaveBeenCalledOnce()
    })

    it('toggles shuffle and cycles repeat mode from their buttons', async () => {
      const wrapper = mountWithSong()
      await wrapper.vm.$nextTick()
      const playback = usePlaybackStore()
      const shuffleSpy = vi.spyOn(playback, 'toggleShuffle')
      const repeatSpy = vi.spyOn(playback, 'cycleRepeatMode')

      await wrapper.get('.mdi-shuffle').trigger('click')
      await wrapper.get('.mdi-repeat').trigger('click')

      expect(shuffleSpy).toHaveBeenCalledOnce()
      expect(repeatSpy).toHaveBeenCalledOnce()
    })
  })

  describe('a radio station is playing', () => {
    function mountWithRadio() {
      const wrapper = mountControls()
      usePlaybackStore().radioStation = {
        id: 'r1',
        name: 'Some Radio',
        streamUrl: 'http://station/stream',
        homePageUrl: null,
      }
      return wrapper
    }

    /** Everything that acts on a queue: a live stream has none, so the
     * store's own playPrevious()/playNext()/toggleShuffle() return early
     * and these buttons would look pressable while doing nothing. */
    it('disables shuffle, previous, next and repeat, keeping play/pause', async () => {
      const wrapper = mountWithRadio()
      await wrapper.vm.$nextTick()
      const disabled = (icon: string) =>
        wrapper.get(`.${icon}`).element.closest('button')!.hasAttribute('disabled')

      expect(disabled('mdi-shuffle')).toBe(true)
      expect(disabled('mdi-skip-previous')).toBe(true)
      expect(disabled('mdi-skip-next')).toBe(true)
      expect(disabled('mdi-repeat')).toBe(true)
      expect(wrapper.get('.play-btn').attributes('disabled')).toBeUndefined()
    })

    /** A shuffle/repeat left on from the last queue must not keep its
     * "active" highlight on a station it no longer applies to. */
    it('drops the shuffle/repeat active colour', async () => {
      const wrapper = mountWithRadio()
      const playback = usePlaybackStore()
      playback.shuffle = true
      playback.repeatMode = 'all'
      await wrapper.vm.$nextTick()

      expect(wrapper.get('.mdi-shuffle').element.closest('button')!.className).not.toContain(
        'text-primary',
      )
      expect(wrapper.get('.mdi-repeat').element.closest('button')!.className).not.toContain(
        'text-primary',
      )
    })
  })
})
