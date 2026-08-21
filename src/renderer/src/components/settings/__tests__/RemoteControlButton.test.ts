import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useRemoteControlStore } from '@/stores/remoteControl'
import RemoteControlButton from '../RemoteControlButton.vue'

const vuetify = createVuetify({ components, directives })

// RemoteControlPairingDialog.vue draws a real QR code onto a <canvas> (via
// the `qrcode` package) whenever it opens — unrelated to what this button
// itself is responsible for (enabling on first click, opening that dialog
// at the right moments), so it's stubbed out here the same way
// ConnectDevicePicker.test.ts stubs AirplayPairingDialog.
function mountButton() {
  return mount(RemoteControlButton, {
    global: {
      plugins: [vuetify, i18n],
      stubs: { RemoteControlPairingDialog: true },
      // $emitter is a global property (see main.ts), not something a
      // plugin injects — global.mocks is what @vue/test-utils uses for
      // exactly that.
      mocks: { $emitter: emitter },
    },
  })
}

describe('RemoteControlButton', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('one click both enables remote control and opens the pairing dialog, while disabled', async () => {
    const store = useRemoteControlStore()
    const enableSpy = vi.spyOn(store, 'enable').mockResolvedValue()
    const wrapper = mountButton()

    await wrapper.get('button').trigger('click')

    expect(enableSpy).toHaveBeenCalledOnce()
    const dialog = wrapper.getComponent({ name: 'RemoteControlPairingDialog' })
    expect(dialog.props('modelValue')).toBe(true)
  })

  it('disables remote control on a second click, without touching the pairing dialog', async () => {
    const store = useRemoteControlStore()
    store.enabled = true
    const disableSpy = vi.spyOn(store, 'disable').mockResolvedValue()
    const wrapper = mountButton()

    await wrapper.get('button').trigger('click')

    expect(disableSpy).toHaveBeenCalledOnce()
    const dialog = wrapper.getComponent({ name: 'RemoteControlPairingDialog' })
    expect(dialog.props('modelValue')).toBe(false)
  })

  it('shows an error toast (enableFailed) and leaves the dialog closed when enable() fails', async () => {
    const store = useRemoteControlStore()
    vi.spyOn(store, 'enable').mockRejectedValue(new Error('network down'))
    const wrapper = mountButton()
    const toastSpy = vi.fn()
    emitter.on('toast', toastSpy)

    await wrapper.get('button').trigger('click')

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: "Couldn't enable Remote Control." }),
    )
    const dialog = wrapper.getComponent({ name: 'RemoteControlPairingDialog' })
    expect(dialog.props('modelValue')).toBe(false)
    emitter.off('toast', toastSpy)
  })

  it('shows an error toast (disableFailed) and stays showing as enabled when disable() fails', async () => {
    const store = useRemoteControlStore()
    store.enabled = true
    vi.spyOn(store, 'disable').mockRejectedValue(new Error('network down'))
    const wrapper = mountButton()
    const toastSpy = vi.fn()
    emitter.on('toast', toastSpy)

    await wrapper.get('button').trigger('click')

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: "Couldn't disable Remote Control." }),
    )
    expect(wrapper.get('button').classes()).toContain('text-primary')
    emitter.off('toast', toastSpy)
  })

  it('shows the button in primary color once enabled', async () => {
    const store = useRemoteControlStore()
    const wrapper = mountButton()
    const btn = () => wrapper.get('button')

    expect(btn().classes()).not.toContain('text-primary')

    store.enabled = true
    await wrapper.vm.$nextTick()

    expect(btn().classes()).toContain('text-primary')
  })
})
