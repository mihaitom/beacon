import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useRadioSettingsStore } from '@/stores/radioSettings'
import SettingsView from '../SettingsView.vue'

const vuetify = createVuetify({ components, directives })

function mountSettings() {
  return mount(SettingsView, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
      stubs: { ConnectButton: true, RemoteControlButton: true },
    },
  })
}

function findRadioToggle(wrapper: ReturnType<typeof mountSettings>) {
  const label = wrapper.vm.$t('settings.castRadioDirectly')
  const toggle = wrapper
    .findAllComponents({ name: 'VSwitch' })
    .find((c) => c.text().includes(label))
  if (!toggle) throw new Error('radio cast-directly toggle not found')
  return toggle
}

describe('SettingsView radio cast-directly toggle', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('shows the toggle, reflecting the store default (off — relayed by default)', () => {
    const wrapper = mountSettings()

    const toggle = findRadioToggle(wrapper)
    expect(toggle.props('modelValue')).toBe(false)
  })

  it('flips the store when toggled', async () => {
    const wrapper = mountSettings()
    const store = useRadioSettingsStore()

    const toggle = findRadioToggle(wrapper)
    await toggle.vm.$emit('update:modelValue', true)

    expect(store.castDirectly).toBe(true)
  })

  it('reflects an already-on store value', () => {
    useRadioSettingsStore().setCastDirectly(true)
    const wrapper = mountSettings()

    expect(findRadioToggle(wrapper).props('modelValue')).toBe(true)
  })
})
