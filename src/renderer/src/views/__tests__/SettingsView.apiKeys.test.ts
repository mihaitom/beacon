// The installation-wide API keys (Last.fm, Fanart.tv) are part of the
// Advanced tab now. The tab itself is what keeps setup out of everyone
// else's way, so there is no separate "show advanced features" switch to
// find first — this holds down that the section is still wired into the
// page, not the switch that used to reveal it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { getApiKeyStatuses, setApiKey } from '@/services/connect/apiKeys'
import SettingsView from '../SettingsView.vue'

vi.mock('@/services/connect/apiKeys', () => ({
  getApiKeyStatuses: vi.fn(),
  setApiKey: vi.fn(),
}))

const NONE_SET = {
  lastfm: { configured: false, fromEnvironment: false },
  fanart: { configured: false, fromEnvironment: false },
}

const vuetify = createVuetify({ components, directives })

async function mountSettings() {
  // The API keys live in the admin-only Advanced tab now.
  useAuthStore().isAdmin = true
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

describe('SettingsView API keys', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(getApiKeyStatuses).mockReset().mockResolvedValue(NONE_SET)
    vi.mocked(setApiKey).mockReset().mockResolvedValue(NONE_SET)
  })

  it('offers the API key section without a switch to find first', async () => {
    const wrapper = await mountSettings()
    const label = wrapper.vm.$t('settings.apiKeyLabel', {
      service: wrapper.vm.$t('settings.lastfmTitle'),
    })

    const field = wrapper
      .findAllComponents({ name: 'VTextField' })
      .find((c) => c.props('label') === label)

    expect(field).toBeDefined()
    expect(wrapper.findAll('.section-title').map((h) => h.text())).toContain(
      wrapper.vm.$t('settings.apiKeysTitle'),
    )
  })
})
