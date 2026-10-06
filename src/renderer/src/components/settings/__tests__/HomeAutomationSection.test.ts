// Access for home automation: the key is shown once and never kept, and the
// fixed port is only stored when it is one main would accept.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useRemoteControlStore } from '@/stores/remoteControl'
import HomeAutomationSection from '../HomeAutomationSection.vue'

const vuetify = createVuetify({ components, directives })

type PortInfo = { port: number | null; fromEnvironment: boolean; current: number | null }

let portInfo: PortInfo
const setConnectPort = vi.fn()

function installApi() {
  ;(window as unknown as { api: unknown }).api = {
    appConfig: {
      getConnectPort: vi.fn(async () => ({ ...portInfo })),
      setConnectPort,
    },
  }
}

async function mountSection() {
  const emit = vi.fn()
  const wrapper = mount(HomeAutomationSection, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit, on: vi.fn(), off: vi.fn() } },
    },
  })
  await flushPromises()
  return { wrapper, emit }
}

function field(wrapper: Awaited<ReturnType<typeof mountSection>>['wrapper'], key: string) {
  const label = wrapper.vm.$t(key)
  return wrapper.findAllComponents({ name: 'VTextField' }).find((c) => c.props('label') === label)
}

function button(wrapper: Awaited<ReturnType<typeof mountSection>>['wrapper'], key: string) {
  const text = wrapper.vm.$t(key)
  return wrapper.findAllComponents({ name: 'VBtn' }).find((b) => b.text() === text)
}

describe('HomeAutomationSection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    portInfo = { port: null, fromEnvironment: false, current: 51234 }
    setConnectPort.mockReset().mockImplementation(async (port: number | null) => {
      portInfo = { ...portInfo, port }
    })
    installApi()
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('renders nothing in the web build', async () => {
    delete (window as unknown as { api?: unknown }).api
    const { wrapper } = await mountSection()
    expect(wrapper.find('section').exists()).toBe(false)
  })

  it('opens its doc in the help dialog', async () => {
    const { wrapper, emit } = await mountSection()
    await button(wrapper, 'settings.homeAutomationDocs')!.trigger('click')
    expect(emit).toHaveBeenCalledWith('openHelp', 'home-automation')
  })

  it('shows a freshly generated key once', async () => {
    const store = useRemoteControlStore()
    vi.spyOn(store, 'generateIntegrationKey').mockResolvedValue('the-key')
    const { wrapper } = await mountSection()

    await button(wrapper, 'settings.homeAutomationGenerate')!.trigger('click')
    await flushPromises()

    expect(field(wrapper, 'settings.homeAutomationKey')!.props('modelValue')).toBe('the-key')
  })

  it('hides the key again once it is revoked', async () => {
    const store = useRemoteControlStore()
    vi.spyOn(store, 'generateIntegrationKey').mockImplementation(async () => {
      store.integration = true
      return 'the-key'
    })
    vi.spyOn(store, 'revokeIntegrationKey').mockImplementation(async () => {
      store.integration = false
    })
    const { wrapper } = await mountSection()
    await button(wrapper, 'settings.homeAutomationGenerate')!.trigger('click')
    await flushPromises()

    await button(wrapper, 'settings.homeAutomationRevoke')!.trigger('click')
    await flushPromises()

    expect(field(wrapper, 'settings.homeAutomationKey')).toBeUndefined()
  })

  it('reports a failed key request instead of failing silently', async () => {
    const store = useRemoteControlStore()
    vi.spyOn(store, 'generateIntegrationKey').mockRejectedValue(new Error('500'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { wrapper, emit } = await mountSection()

    await button(wrapper, 'settings.homeAutomationGenerate')!.trigger('click')
    await flushPromises()

    expect(emit).toHaveBeenCalledWith('toast', expect.objectContaining({ level: 'error' }))
  })

  it('stores a valid port', async () => {
    const { wrapper } = await mountSection()

    await field(wrapper, 'settings.fixedPort')!.vm.$emit('update:modelValue', '8123')
    await button(wrapper, 'common.save')!.trigger('click')
    await flushPromises()

    expect(setConnectPort).toHaveBeenCalledWith(8123)
  })

  it.each(['80', '70000', '12.5'])('does not store port %s', async (value) => {
    const { wrapper } = await mountSection()

    await field(wrapper, 'settings.fixedPort')!.vm.$emit('update:modelValue', value)
    await (wrapper.vm as unknown as { savePort: () => Promise<void> }).savePort()
    await flushPromises()

    expect(setConnectPort).not.toHaveBeenCalled()
  })

  it('goes back to a free port', async () => {
    portInfo = { port: 8123, fromEnvironment: false, current: 8123 }
    const { wrapper } = await mountSection()

    await button(wrapper, 'settings.fixedPortClear')!.trigger('click')
    await flushPromises()

    expect(setConnectPort).toHaveBeenCalledWith(null)
  })

  it.each([
    ['from the settings', false],
    ['from BEACON_PORT', true],
  ])('warns when the fixed port %s was taken at start', async (_, fromEnvironment) => {
    portInfo = { port: 8123, fromEnvironment, current: 51234 }
    const { wrapper } = await mountSection()

    const alert = wrapper.findComponent({ name: 'VAlert' })
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain(
      wrapper.vm.$t('settings.fixedPortTaken', { port: 8123, current: 51234 }),
    )
  })

  it('shows no warning while the fixed port is in use', async () => {
    portInfo = { port: 8123, fromEnvironment: false, current: 8123 }
    const { wrapper } = await mountSection()

    expect(wrapper.findComponent({ name: 'VAlert' }).exists()).toBe(false)
  })

  it('leaves a port set by the environment read-only', async () => {
    portInfo = { port: 8123, fromEnvironment: true, current: 8123 }
    const { wrapper } = await mountSection()

    expect(field(wrapper, 'settings.fixedPort')!.props('disabled')).toBe(true)
    expect(button(wrapper, 'settings.fixedPortClear')).toBeUndefined()
  })

  // Home Assistant finds Beacon over mDNS; the address only matters for a
  // setup by hand, which only lasts with a fixed port.
  it('shows the address for a setup by hand while a fixed port is in use', async () => {
    portInfo = { port: 8123, fromEnvironment: false, current: 8123 }
    useRemoteControlStore().lanIp = '192.0.2.5'
    const { wrapper } = await mountSection()

    expect(wrapper.text()).toContain(
      wrapper.vm.$t('settings.fixedPortManual', { address: '192.0.2.5', port: 8123 }),
    )
  })

  it.each([
    ['without a fixed port', { port: null, fromEnvironment: false, current: 51234 }],
    ['while the fixed port was taken', { port: 8123, fromEnvironment: false, current: 51234 }],
  ])('shows no address %s', async (_, info) => {
    portInfo = info
    useRemoteControlStore().lanIp = '192.0.2.5'
    const { wrapper } = await mountSection()

    expect(wrapper.text()).not.toContain('192.0.2.5')
  })

  it('offers no port setting in dev, where connect picks its own', async () => {
    portInfo = { port: null, fromEnvironment: false, current: null }
    const { wrapper } = await mountSection()

    expect(field(wrapper, 'settings.fixedPort')).toBeUndefined()
  })
})
