// The advanced-features switch and the Last.fm API key field behind it.
// The switch exists so the person who did not set the music server up
// never meets the setup controls; the key field is the first thing it
// covers, and the one that makes the playlist builder appear at all.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { getLastfmStatus, setLastfmApiKey } from '@/services/connect/lastfm'
import SettingsView from '../SettingsView.vue'

vi.mock('@/services/connect/lastfm', () => ({
  getLastfmStatus: vi.fn().mockResolvedValue({ configured: false, fromEnvironment: false }),
  setLastfmApiKey: vi.fn().mockResolvedValue({ configured: true, fromEnvironment: false }),
}))

const vuetify = createVuetify({ components, directives })

async function mountSettings() {
  const wrapper = mount(SettingsView, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
      stubs: { ConnectButton: true, RemoteControlButton: true },
    },
  })
  await flushPromises()
  return wrapper
}

function advancedToggle(wrapper: Awaited<ReturnType<typeof mountSettings>>) {
  const label = wrapper.vm.$t('settings.advancedMode')
  const toggle = wrapper
    .findAllComponents({ name: 'VSwitch' })
    .find((c) => c.text().includes(label))
  if (!toggle) throw new Error('advanced-mode toggle not found')
  return toggle
}

function keyField(wrapper: Awaited<ReturnType<typeof mountSettings>>) {
  const label = wrapper.vm.$t('settings.lastfmKey')
  return wrapper.findAllComponents({ name: 'VTextField' }).find((c) => c.props('label') === label)
}

describe('SettingsView advanced features', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(getLastfmStatus).mockReset()
    vi.mocked(setLastfmApiKey).mockReset()
    vi.mocked(getLastfmStatus).mockResolvedValue({ configured: false, fromEnvironment: false })
    vi.mocked(setLastfmApiKey).mockResolvedValue({ configured: true, fromEnvironment: false })
  })

  it('hides the whole Last.fm section until advanced features are switched on', async () => {
    // The section, not just the control inside it: a heading with nothing
    // under it is what gating one field at a time leaves behind.
    const wrapper = await mountSettings()
    const headings = () => wrapper.findAll('.section-title').map((h) => h.text())

    expect(keyField(wrapper)).toBeUndefined()
    expect(headings()).not.toContain(wrapper.vm.$t('settings.lastfmTitle'))

    await advancedToggle(wrapper).vm.$emit('update:modelValue', true)
    await flushPromises()

    expect(keyField(wrapper)).toBeDefined()
    expect(headings()).toContain(wrapper.vm.$t('settings.lastfmTitle'))
  })

  it('keeps the switch itself in the Advanced section, where it can be found', async () => {
    // The switch must not hide with what it reveals, or nothing could
    // ever turn it back on.
    const wrapper = await mountSettings()
    const headings = wrapper.findAll('.section-title').map((h) => h.text())

    expect(headings).toContain(wrapper.vm.$t('settings.advancedTitle'))
    expect(advancedToggle(wrapper).exists()).toBe(true)
  })

  it('offers the switch itself to everyone, so it can be found', async () => {
    const wrapper = await mountSettings()
    expect(advancedToggle(wrapper).props('modelValue')).toBe(false)
  })
})
