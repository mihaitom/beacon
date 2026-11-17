// The retired home automation key: shown once and never kept, and still
// working until a later release removes it.
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

function installApi() {
  ;(window as unknown as { api: unknown }).api = {}
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
    installApi()
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
    vi.unstubAllGlobals()
  })

  it('renders nothing in the web build', async () => {
    delete (window as unknown as { api?: unknown }).api
    const { wrapper } = await mountSection()
    expect(wrapper.find('section').exists()).toBe(false)
  })

  it('opens its doc in the help dialog', async () => {
    const { wrapper, emit } = await mountSection()
    await button(wrapper, 'settings.homeAutomationDocs')!.trigger('click')
    expect(emit).toHaveBeenCalledWith('openHelp', 'guides/home-automation')
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

  /** The key is only shown once, so copying it out is the main way to get
   * it anywhere - and the copy button should say that it worked. */
  it('puts the key on the clipboard and confirms it did', async () => {
    const { wrapper } = await mountSection()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await (wrapper.vm as unknown as { copy(text: string): Promise<void> }).copy('the-key')

    expect(writeText).toHaveBeenCalledWith('the-key')
    // What turns the icon into a checkmark.
    expect((wrapper.vm as unknown as { keyCopied: boolean }).keyCopied).toBe(true)
  })

  it('does not claim success when the clipboard refuses', async () => {
    const { wrapper } = await mountSection()
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await (wrapper.vm as unknown as { copy(text: string): Promise<void> }).copy('the-key')

    expect((wrapper.vm as unknown as { keyCopied: boolean }).keyCopied).toBe(false)
  })
})
