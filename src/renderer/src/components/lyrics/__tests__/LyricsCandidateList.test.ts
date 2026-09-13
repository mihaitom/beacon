import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useLyricsStore } from '@/stores/lyrics'
import type { LyricSearchResult } from '@/services/connect/types'
import LyricsCandidateList from '../LyricsCandidateList.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function candidate(id: string, name: string): LyricSearchResult {
  return {
    id,
    name,
    artist: 'Some Artist',
    source: 'lrclib',
    score: 0.1,
    duration: 180,
    isSync: true,
  }
}

/** Picking a match is the one interaction this list has, and the state it
 * leaves behind is shared with whatever container is showing it. */
describe('LyricsCandidateList', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    usePlaybackStore().setQueue([makeSong('a')], 0)
  })

  function mountList() {
    const lyrics = useLyricsStore()
    lyrics.candidates = { lrclib: [candidate('1', 'First'), candidate('2', 'Second')] }
    lyrics.candidatesLoading = false
    return mount(LyricsCandidateList, { global: { plugins: [vuetify, i18n] } })
  }

  it('tells its container to close when a match is picked', async () => {
    // Without this the picker stayed up after a pick. It used to then
    // show "No other matches found.", because selecting emptied the list;
    // the list is held now, but a picker that ignores the tap is still
    // wrong.
    const lyrics = useLyricsStore()
    vi.spyOn(lyrics, 'selectCandidate').mockResolvedValue()
    const wrapper = mountList()

    await wrapper.findAll('.lyrics-candidate-list__item')[1]!.trigger('click')

    expect(wrapper.emitted('select')).toHaveLength(1)
    expect(lyrics.selectCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
      'lrclib',
      '2',
    )
  })

  it('still says so when a search genuinely came back empty', () => {
    const lyrics = useLyricsStore()
    lyrics.candidates = {}
    lyrics.candidatesLoading = false

    const wrapper = mount(LyricsCandidateList, { global: { plugins: [vuetify, i18n] } })

    expect(wrapper.text()).toContain('No other matches found.')
  })
})
