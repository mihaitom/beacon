import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import QueueRow from '../QueueRow.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function mountRow(index: number) {
  return mount(QueueRow, {
    props: { song: makeSong(String(index)), index },
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
  })
}

function playRadio() {
  usePlaybackStore().radioStation = {
    id: 'r1',
    name: 'Some Radio',
    streamUrl: 'http://station/stream',
    homePageUrl: null,
  }
}

describe('QueueRow', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    usePlaybackStore().setQueue([makeSong('0'), makeSong('1')], 1)
  })

  it('marks the queue position with a speaker icon in place of its number', () => {
    const current = mountRow(1)
    const other = mountRow(0)

    expect(current.find('.mdi-volume-high').exists()).toBe(true)
    expect(current.get('.queue-row').classes()).toContain('queue-row--current')
    expect(other.find('.mdi-volume-high').exists()).toBe(false)
    expect(other.get('.queue-row__index').text()).toBe('1')
  })

  // The queue survives a radio station now, so its position is still worth
  // marking while one plays — but nothing in that row is audible, and a
  // speaker icon there would say otherwise.
  it('keeps the marker but drops the speaker icon while a station plays over the queue', async () => {
    const wrapper = mountRow(1)
    playRadio()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.mdi-volume-high').exists()).toBe(false)
    expect(wrapper.get('.queue-row__index').text()).toBe('2')
    expect(wrapper.get('.queue-row').classes()).toContain('queue-row--current')
    // Still the queue's current row: removing it would leave currentIndex
    // pointing somewhere else entirely.
    expect(wrapper.get('.mdi-close').element.closest('button')!.hasAttribute('disabled')).toBe(true)
  })
})
