import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useLyricsStore } from '@/stores/lyrics'
import LyricsPanel from '../LyricsPanel.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

/** Scrolling the lyrics by hand is a request to read something other than
 * the line that happens to be playing. Autoscroll used to take the list
 * back after a few seconds, which meant reading an earlier verse got
 * interrupted mid-sentence. */
describe('LyricsPanel autoscroll pausing', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)
    playback.localPosition = 40
    const lyrics = useLyricsStore()
    vi.spyOn(lyrics, 'ensureLoaded').mockResolvedValue()
    lyrics.songId = 'a'
    lyrics.synced = true
    lyrics.lines = Array.from({ length: 20 }, (_, i) => ({ time: i * 4, text: `Line ${i + 1}` }))
  })

  function mountPanel() {
    return mount(LyricsPanel, { global: { plugins: [vuetify, i18n] } })
  }

  function resumeButton(wrapper: ReturnType<typeof mountPanel>) {
    return wrapper.find('.lyrics-panel__resume-btn')
  }

  it('offers nothing to press while it is following the song', () => {
    const wrapper = mountPanel()

    expect((wrapper.vm as unknown as { autoscrollPaused: boolean }).autoscrollPaused).toBe(false)
    expect(resumeButton(wrapper).exists()).toBe(false)
  })

  it('stops following as soon as the list is scrolled by hand', async () => {
    const wrapper = mountPanel()

    await wrapper.get('.lyrics-panel__scroll').trigger('wheel')

    expect((wrapper.vm as unknown as { autoscrollPaused: boolean }).autoscrollPaused).toBe(true)
    expect(resumeButton(wrapper).exists()).toBe(true)
  })

  it('stays stopped however long the song keeps playing', async () => {
    // The regression this replaces: a four-second timer put the list back
    // under playback's control on its own, mid-read.
    vi.useFakeTimers()
    const wrapper = mountPanel()
    await wrapper.get('.lyrics-panel__scroll').trigger('wheel')

    vi.advanceTimersByTime(60_000)
    const playback = usePlaybackStore()
    playback.localPosition = 72 // several lines further on
    await wrapper.vm.$nextTick()

    expect((wrapper.vm as unknown as { autoscrollPaused: boolean }).autoscrollPaused).toBe(true)
    expect(resumeButton(wrapper).exists()).toBe(true)
    vi.useRealTimers()
  })

  it('follows again once the button is pressed, and hides it', async () => {
    const wrapper = mountPanel()
    await wrapper.get('.lyrics-panel__scroll').trigger('wheel')

    await resumeButton(wrapper).trigger('click')

    expect((wrapper.vm as unknown as { autoscrollPaused: boolean }).autoscrollPaused).toBe(false)
    expect(resumeButton(wrapper).exists()).toBe(false)
  })

  it('keeps the button out of the way while calibrating', async () => {
    // Calibration pauses autoscroll too, but it has its own way out (the
    // target button) — a second one saying "follow again" would be two
    // controls for one state.
    const wrapper = mountPanel()
    const vm = wrapper.vm as unknown as { calibrating: boolean }
    vm.calibrating = true
    await wrapper.vm.$nextTick()

    expect(resumeButton(wrapper).exists()).toBe(false)
  })
})
