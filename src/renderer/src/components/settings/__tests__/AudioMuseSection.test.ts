import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { getAudioMuseSettings, getAudioMuseStatus } from '@/services/connect/audiomuse'
import AudioMuseSection from '../AudioMuseSection.vue'

vi.mock('@/services/connect/audiomuse', () => ({
  getAudioMuseSettings: vi.fn(),
  saveAudioMuseSettings: vi.fn(),
  getAudioMuseStatus: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })
const NOTHING = {
  url: '',
  urlFromEnvironment: false,
  urlFromServer: false,
  key: { configured: false, fromEnvironment: false, fromServer: false },
}
const LENT = {
  url: 'http://audiomuse.local:8000',
  urlFromEnvironment: false,
  urlFromServer: true,
  key: { configured: true, fromEnvironment: false, fromServer: true },
}

function mountSection() {
  return mount(AudioMuseSection, {
    global: { plugins: [vuetify, i18n], mocks: { $emitter: emitter } },
  })
}

describe('AudioMuseSection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getAudioMuseSettings).mockReset().mockResolvedValue(NOTHING)
    vi.mocked(getAudioMuseStatus)
      .mockReset()
      .mockResolvedValue({ available: false, reason: 'not-configured' })
  })

  it('shows what a sync with the paired server brought, without reopening Settings', async () => {
    const wrapper = mountSection()
    await flushPromises()

    vi.mocked(getAudioMuseSettings).mockResolvedValue(LENT)
    vi.mocked(getAudioMuseStatus).mockResolvedValue({ available: true, version: '3.7.4' })
    emitter.emit('serverLinkSynced')
    await flushPromises()

    expect((wrapper.get('input').element as HTMLInputElement).value).toBe(LENT.url)
    expect(getAudioMuseStatus).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('leaves an address being typed alone', async () => {
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('input').setValue('http://typing')

    vi.mocked(getAudioMuseSettings).mockResolvedValue(LENT)
    emitter.emit('serverLinkSynced')
    await flushPromises()

    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('http://typing')
    wrapper.unmount()
  })
})
