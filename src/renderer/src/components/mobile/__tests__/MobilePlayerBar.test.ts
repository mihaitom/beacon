import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import MobilePlayerBar from '../MobilePlayerBar.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import { MOBILE_ROW_ART_SIZE } from '../rowMetrics'

const vuetify = createVuetify({ components, directives })

async function mountBar() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/m/now-playing', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()
  // Wrapped in a v-layout: the bar is a `v-footer app`, which registers
  // itself with Vuetify's layout system and throws ("Could not find
  // injected layout") mounted on its own — MobileLayout.vue is what
  // provides that in the app.
  return mount(
    {
      components: { MobilePlayerBar },
      template: '<v-layout><mobile-player-bar /></v-layout>',
    },
    { global: { plugins: [vuetify, i18n, router], stubs: { CoverArt: true } } },
  )
}

function playRadio() {
  usePlaybackStore().radioStation = {
    id: 'r1',
    name: 'Some Radio',
    streamUrl: 'http://station/stream',
    homePageUrl: null,
  }
}

/** The two stacked labels, top (title) first. */
function labels(wrapper: Awaited<ReturnType<typeof mountBar>>) {
  return wrapper.findAll('.mobile-player-bar__labels > div').map((el) => el.text())
}

describe('MobilePlayerBar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /** Not gated on hasPrevious: at the start of a queue "previous" restarts
   * the current song rather than doing nothing. */
  it('offers previous, play and next for a song', async () => {
    const wrapper = await mountBar()
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)
    await wrapper.vm.$nextTick()
    const previousSpy = vi.spyOn(playback, 'playPrevious').mockResolvedValue()

    const previous = wrapper.get('.mdi-skip-previous').element.closest('button')!
    expect(previous.hasAttribute('disabled')).toBe(false)
    await wrapper.get('.mdi-skip-previous').trigger('click')

    expect(previousSpy).toHaveBeenCalledOnce()
  })

  /** This strip sits directly under a list of MobileSongRow/MobileAlbumRow
   * entries, and the phone remote's own mini player already matches its
   * rows — a 40px cover here beside 48px ones there was the last piece of
   * the drift. */
  it('shows artwork at the same size the rows above it do', async () => {
    const wrapper = await mountBar()
    usePlaybackStore().setQueue([makeSong('a')], 0)
    await wrapper.vm.$nextTick()

    expect(wrapper.getComponent({ name: 'CoverArt' }).props('size')).toBe(MOBILE_ROW_ART_SIZE)
  })

  it('shows a song title and artist', async () => {
    const wrapper = await mountBar()
    usePlaybackStore().setQueue([makeSong('a', { title: 'Track A', artist: 'Artist A' })], 0)
    await wrapper.vm.$nextTick()

    expect(labels(wrapper)).toEqual(['Track A', 'Artist A'])
  })

  describe('radio', () => {
    // Same fallback chain (and the same swap once a tag arrives)
    // NowPlayingView.vue/SongInfo.vue use — the ICY tag is the prominent
    // label, the station the secondary one.
    it('shows the station name alone until an ICY tag arrives', async () => {
      const wrapper = await mountBar()
      playRadio()
      await wrapper.vm.$nextTick()

      expect(labels(wrapper)).toEqual(['Some Radio', ''])
    })

    it('promotes the ICY tag to the title and drops the station to the second line', async () => {
      const wrapper = await mountBar()
      playRadio()
      usePlaybackStore().radioNowPlaying = 'Some Artist - Some Song'
      await wrapper.vm.$nextTick()

      expect(labels(wrapper)).toEqual(['Some Artist - Some Song', 'Some Radio'])
    })

    it('disables both skip buttons, which have no queue to move through', async () => {
      const wrapper = await mountBar()
      playRadio()
      // Repeat mode is the one way hasNext goes true on an empty queue —
      // it must not re-enable the button for a live stream.
      usePlaybackStore().repeatMode = 'all'
      await wrapper.vm.$nextTick()

      const next = wrapper.get('.mdi-skip-next').element.closest('button')!
      const previous = wrapper.get('.mdi-skip-previous').element.closest('button')!
      expect(next.hasAttribute('disabled')).toBe(true)
      expect(previous.hasAttribute('disabled')).toBe(true)
      // Play/pause is the one transport control a live stream does have.
      expect(wrapper.get('.mdi-play').element.closest('button')!.hasAttribute('disabled')).toBe(
        false,
      )
    })
  })
})
