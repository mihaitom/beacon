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

/** What the panel shows when it has no lines to show. Both cases are
 * normal here rather than exceptional: a lookup takes a moment, and plenty
 * of songs simply have no lyrics anywhere. */
describe('LyricsPanel without lyrics', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)
    const lyrics = useLyricsStore()
    vi.spyOn(lyrics, 'ensureLoaded').mockResolvedValue()
    lyrics.songId = 'a'
  })

  function mountPanel(variant: 'compact' | 'immersive' = 'compact') {
    return mount(LyricsPanel, { props: { variant }, global: { plugins: [vuetify, i18n] } })
  }

  it('says it is looking while the lookup runs', () => {
    useLyricsStore().loading = true

    const wrapper = mountPanel()

    expect(wrapper.get('.lyrics-panel__status').text()).toBe('Looking for lyrics …')
  })

  it('says the same thing in the fullscreen view', () => {
    // The two used to disagree: the drawer drew placeholder bones, the
    // immersive view showed nothing at all, because bones never looked
    // right over its blurred backdrop.
    useLyricsStore().loading = true

    const wrapper = mountPanel('immersive')

    expect(wrapper.get('.lyrics-panel__status').text()).toBe('Looking for lyrics …')
  })

  it('draws no placeholder lines, which would promise lyrics it may not find', () => {
    useLyricsStore().loading = true

    const wrapper = mountPanel()

    expect(wrapper.find('.v-skeleton-loader').exists()).toBe(false)
  })

  it('does not claim there are none for a song nothing has been asked about', async () => {
    // The state a freshly opened lyrics drawer starts in: a song is
    // playing, the panel is on screen, and whoever showed it has not got
    // round to asking yet. Saying "no lyrics found" there reports an
    // outcome nobody looked for — which is exactly what the drawer used to
    // show for its first open of a session.
    const lyrics = useLyricsStore()
    lyrics.loading = false
    lyrics.songId = null
    lyrics.lines = []

    const wrapper = mountPanel()

    expect(wrapper.get('.lyrics-panel__status').text()).toBe('Looking for lyrics …')
  })

  it('says so once the lookup came back with nothing', async () => {
    const lyrics = useLyricsStore()
    lyrics.loading = true
    const wrapper = mountPanel()

    lyrics.loading = false
    // Answered *for this song* — that is what tells "there are none" apart
    // from "nobody has asked yet" (see the test above).
    lyrics.songId = 'a'
    lyrics.lines = []
    await wrapper.vm.$nextTick()

    // The same box, a different sentence — nothing about the panel moves
    // between the two.
    expect(wrapper.get('.lyrics-panel__status').text()).toBe('No lyrics found for this song.')
  })

  it('steps out of the way once there are lines to show', async () => {
    const lyrics = useLyricsStore()
    lyrics.loading = true
    const wrapper = mountPanel()

    lyrics.loading = false
    lyrics.synced = true
    lyrics.lines = [{ time: 0, text: 'Line one' }]
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.lyrics-panel__status').exists()).toBe(false)
    expect(wrapper.text()).toContain('Line one')
  })
})
