import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAudioMuseStore } from '@/stores/audiomuse'
import { sonicSearch } from '@/services/connect/audiomuse'
import { makeSong } from '@/stores/__tests__/fixtures'
import SonicSearchSection from '../SonicSearchSection.vue'

vi.mock('@/services/connect/audiomuse', () => ({ sonicSearch: vi.fn() }))

const vuetify = createVuetify({ components, directives })

// The table itself is SongTable's business; this is about what is asked
// and what ends up in it.
const SongTableStub = {
  name: 'SongTable',
  props: ['songs', 'loading'],
  template: '<div class="table">{{ songs.map((s) => s.id).join(",") }}</div>',
}

function mountSection(props: Record<string, unknown> = {}) {
  return mount(SonicSearchSection, {
    props: { kind: 'sound', query: 'calm piano', ...props },
    global: { plugins: [vuetify, i18n], stubs: { SongTable: SongTableStub } },
  })
}

describe('SonicSearchSection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    vi.mocked(sonicSearch).mockReset()
    useAudioMuseStore().status = { available: true }
    useAudioMuseStore().checkedAt = Date.now()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows what AudioMuse found for the words', async () => {
    vi.mocked(sonicSearch).mockResolvedValue([makeSong('a'), makeSong('b')])
    const wrapper = mountSection()

    await vi.runAllTimersAsync()
    await flushPromises()

    expect(sonicSearch).toHaveBeenCalledWith('sound', 'calm piano', 20)
    expect(wrapper.get('.table').text()).toBe('a,b')
  })

  it('folds a long answer even as the last section on the page', async () => {
    vi.mocked(sonicSearch).mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => makeSong(`s${i}`)),
    )
    const wrapper = mountSection()

    await vi.runAllTimersAsync()
    await flushPromises()

    expect(wrapper.get('.table').text().split(',').length).toBeLessThan(20)
    expect(wrapper.find('button').exists()).toBe(true)
  })

  it('waits for the typing to settle and asks only for the last words', async () => {
    vi.mocked(sonicSearch).mockResolvedValue([makeSong('a')])
    const wrapper = mountSection({ query: 'ca' })
    await wrapper.setProps({ query: 'calm' })
    await wrapper.setProps({ query: 'calm piano' })

    await vi.runAllTimersAsync()

    expect(sonicSearch).toHaveBeenCalledTimes(1)
    expect(sonicSearch).toHaveBeenCalledWith('sound', 'calm piano', 20)
  })

  it('never lets an older search replace a newer one', async () => {
    let answerOld!: (songs: ReturnType<typeof makeSong>[]) => void
    vi.mocked(sonicSearch)
      .mockReturnValueOnce(new Promise((resolve) => (answerOld = resolve)))
      .mockResolvedValueOnce([makeSong('new')])
    const wrapper = mountSection({ query: 'old' })
    await vi.runAllTimersAsync()
    await wrapper.setProps({ query: 'new' })
    await vi.runAllTimersAsync()

    answerOld([makeSong('old')])
    await flushPromises()

    expect(wrapper.get('.table').text()).toBe('new')
  })

  it('is not there at all without AudioMuse', async () => {
    useAudioMuseStore().status = { available: false, reason: 'not-configured' }
    const wrapper = mountSection()

    await vi.runAllTimersAsync()

    expect(sonicSearch).not.toHaveBeenCalled()
    expect(wrapper.find('section').exists()).toBe(false)
  })

  it('disappears when nothing was found, and says it is not showing', async () => {
    vi.mocked(sonicSearch).mockResolvedValue([])
    const wrapper = mountSection()

    await vi.runAllTimersAsync()
    await flushPromises()

    expect(wrapper.find('section').exists()).toBe(false)
    expect(wrapper.emitted('showing')?.at(-1)).toEqual([false])
  })

  it('disappears when the search fails', async () => {
    vi.mocked(sonicSearch).mockRejectedValue(new Error('503'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mountSection()

    await vi.runAllTimersAsync()
    await flushPromises()

    expect(wrapper.find('section').exists()).toBe(false)
  })
})
