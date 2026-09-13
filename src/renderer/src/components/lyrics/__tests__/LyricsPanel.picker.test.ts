import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { VBottomSheet } from 'vuetify/components'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useLyricsStore } from '@/stores/lyrics'
import LyricsPanel from '../LyricsPanel.vue'
import LyricsCandidateList from '../LyricsCandidateList.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

/** The "pick a different match" picker, in both the shapes it takes: a
 * dropdown under a mouse, a bottom sheet under a thumb. */
describe('LyricsPanel match picker', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    usePlaybackStore().setQueue([makeSong('a')], 0)
    const lyrics = useLyricsStore()
    vi.spyOn(lyrics, 'ensureLoaded').mockResolvedValue()
    vi.spyOn(lyrics, 'loadCandidates').mockResolvedValue()
    lyrics.songId = 'a'
    lyrics.lines = [{ time: 0, text: 'a line' }]
  })

  function mountPanel(mobile: boolean) {
    return mount(LyricsPanel, {
      props: { variant: 'compact', mobile },
      global: { plugins: [vuetify, i18n] },
    })
  }

  it('puts the bottom sheet away once a match has been picked', async () => {
    // The reported bug: the sheet stayed up after picking, and since
    // selecting emptied the candidate list back then, it re-rendered as
    // "No other matches found." — as if the search it had just been
    // picked from had failed.
    const wrapper = mountPanel(true)
    await wrapper.get('.lyrics-panel__pick-btn').trigger('click')
    expect(wrapper.vm.mobilePickerOpen).toBe(true)

    wrapper.findComponent(LyricsCandidateList).vm.$emit('select')

    expect(wrapper.vm.mobilePickerOpen).toBe(false)
  })

  it('puts the desktop dropdown away too', async () => {
    // Same defect, same fix: close-on-content-click is off there so the
    // menu would have sat open on the empty state just as the sheet did.
    const wrapper = mountPanel(false)
    wrapper.vm.desktopPickerOpen = true
    await wrapper.vm.$nextTick()

    wrapper.findComponent(LyricsCandidateList).vm.$emit('select')

    expect(wrapper.vm.desktopPickerOpen).toBe(false)
  })

  it('keeps the matches when the sheet is dismissed, so reopening is instant', async () => {
    // Closing used to throw the search away, which is why landing on the
    // right sheet cost three third-party lookups per attempt. Dismissed
    // the way a swipe-down or a backdrop tap does it — the sheet reports
    // that itself, which is the path that used to clear them.
    const lyrics = useLyricsStore()
    const wrapper = mountPanel(true)
    await wrapper.get('.lyrics-panel__pick-btn').trigger('click')
    lyrics.candidates = { lrclib: [] }
    lyrics.candidatesSongId = 'a'

    wrapper.findComponent(VBottomSheet).vm.$emit('update:model-value', false)

    expect(lyrics.candidates).not.toBeNull()
    expect(lyrics.candidatesSongId).toBe('a')
  })

  it('opens the sheet already loading its candidates', async () => {
    // v-bottom-sheet emits update:model-value only for changes it makes
    // itself, so opening from out here has to kick the search off by hand
    // — without that the sheet opens permanently empty.
    const wrapper = mountPanel(true)

    await wrapper.get('.lyrics-panel__pick-btn').trigger('click')

    expect(useLyricsStore().loadCandidates).toHaveBeenCalled()
  })
})
