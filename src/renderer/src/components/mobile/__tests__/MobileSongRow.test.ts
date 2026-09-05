import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { usePlaybackStore } from '@/stores/playback'
import MobileSongRow from '../MobileSongRow.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function mountRow(song = makeSong('a')) {
  return mount(MobileSongRow, {
    props: { song },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
  })
}

describe('MobileSongRow', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('plays the song when the row is tapped', async () => {
    const wrapper = mountRow()

    await wrapper.get('.mobile-song-row').trigger('click')

    expect(wrapper.emitted('play')).toHaveLength(1)
  })

  it('opens the action sheet from its own button without playing', async () => {
    const wrapper = mountRow()

    await wrapper.get('.mdi-dots-vertical').trigger('click')

    expect(wrapper.emitted('open-actions')).toHaveLength(1)
    expect(wrapper.emitted('play')).toBeUndefined()
  })

  /** The phone has no way to see favourites — no tab, and nothing linking
   * to the desktop's /favorites page — so a heart here was an action whose
   * result was invisible everywhere in this shell. Asserted against a
   * server that does support favourites, since that is the case where the
   * button used to render. */
  it('offers no favourite toggle, even where the server supports them', async () => {
    const auth = useAuthStore()
    auth.serverType = 'subsonic'
    expect(auth.capabilities.favorites).toBe(true)

    const wrapper = mountRow(makeSong('a', { starred: true }))

    expect(wrapper.find('.mdi-heart').exists()).toBe(false)
    expect(wrapper.find('.mdi-heart-outline').exists()).toBe(false)
  })

  it('marks the song that is playing', async () => {
    const wrapper = mountRow(makeSong('a'))
    expect(wrapper.get('.mobile-song-row').classes()).not.toContain('mobile-song-row--current')

    usePlaybackStore().setQueue([makeSong('a')], 0)
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.mobile-song-row').classes()).toContain('mobile-song-row--current')
  })
})
