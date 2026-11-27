import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useConnectStore } from '@/stores/connect'
import AirplayPairingDialog from '../AirplayPairingDialog.vue'

const vuetify = createVuetify({ components, directives })

// Teleported otherwise, out of the wrapper's reach.
const INLINE_DIALOG = { template: '<div class="stub-dialog"><slot /></div>' }

async function openDialog() {
  const wrapper = mount(AirplayPairingDialog, {
    props: { modelValue: false, deviceName: 'Living Room' },
    global: { plugins: [vuetify, i18n], stubs: { VDialog: INLINE_DIALOG } },
  })
  await wrapper.setProps({ modelValue: true })
  await flushPromises()
  return wrapper
}

function button(wrapper: Awaited<ReturnType<typeof openDialog>>, label: string) {
  return wrapper.findAll('button').find((b) => b.text() === label)
}

async function typePin(wrapper: Awaited<ReturnType<typeof openDialog>>, pin: string) {
  await wrapper.get('.airplay-pairing__pin input').setValue(pin)
  await flushPromises()
}

describe('AirplayPairingDialog', () => {
  let store: ReturnType<typeof useConnectStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useConnectStore()
  })

  it('pairs with a six-digit PIN, leading zero included', async () => {
    vi.spyOn(store, 'startPairing').mockResolvedValue({ device_provides_pin: true } as never)
    const finish = vi.spyOn(store, 'finishPairing').mockResolvedValue()
    const wrapper = await openDialog()

    // jsdom ignores maxlength when a value is set, so it is checked apart.
    expect(wrapper.get('.airplay-pairing__pin input').attributes('maxlength')).toBeUndefined()
    await typePin(wrapper, '012345')
    await button(wrapper, 'Done')!.trigger('click')
    await flushPromises()

    expect(finish).toHaveBeenCalledWith('Living Room', '012345')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
  })

  it('pairs on Enter with a four-digit PIN', async () => {
    vi.spyOn(store, 'startPairing').mockResolvedValue({ device_provides_pin: true } as never)
    const finish = vi.spyOn(store, 'finishPairing').mockResolvedValue()
    const wrapper = await openDialog()

    await typePin(wrapper, '0427')
    await wrapper.get('.airplay-pairing__pin input').trigger('keyup', { key: 'Enter' })
    await flushPromises()

    expect(finish).toHaveBeenCalledWith('Living Room', '0427')
  })

  it('holds Done back until a PIN is typed', async () => {
    vi.spyOn(store, 'startPairing').mockResolvedValue({ device_provides_pin: true } as never)
    const wrapper = await openDialog()

    expect(button(wrapper, 'Done')?.attributes('disabled')).toBeDefined()
  })

  it('takes a PIN of any length', async () => {
    vi.spyOn(store, 'startPairing').mockResolvedValue({ device_provides_pin: true } as never)
    const finish = vi.spyOn(store, 'finishPairing').mockResolvedValue()
    const wrapper = await openDialog()

    await typePin(wrapper, '12')
    await button(wrapper, 'Done')!.trigger('click')
    await flushPromises()

    expect(finish).toHaveBeenCalledWith('Living Room', '12')
  })

  it('takes a password with letters and special characters', async () => {
    vi.spyOn(store, 'startPairing').mockResolvedValue({ device_provides_pin: true } as never)
    const finish = vi.spyOn(store, 'finishPairing').mockResolvedValue()
    const wrapper = await openDialog()

    await typePin(wrapper, 'Kü che#1')
    await button(wrapper, 'Done')!.trigger('click')
    await flushPromises()

    expect(finish).toHaveBeenCalledWith('Living Room', 'Kü che#1')
  })

  it('pairs on Done when the device asks for a confirmation instead', async () => {
    vi.spyOn(store, 'startPairing').mockResolvedValue({ device_provides_pin: false } as never)
    const finish = vi.spyOn(store, 'finishPairing').mockResolvedValue()
    const wrapper = await openDialog()

    await button(wrapper, 'Done')!.trigger('click')
    await flushPromises()

    expect(finish).toHaveBeenCalledWith('Living Room', undefined)
  })

  it('starts over after a rejected PIN', async () => {
    const start = vi
      .spyOn(store, 'startPairing')
      .mockResolvedValue({ device_provides_pin: true } as never)
    vi.spyOn(store, 'finishPairing').mockRejectedValueOnce(new Error('Incorrect PIN'))
    const wrapper = await openDialog()

    await typePin(wrapper, '1111')
    await button(wrapper, 'Done')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Incorrect PIN')

    await button(wrapper, 'Retry')!.trigger('click')
    await flushPromises()

    expect(start).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('Incorrect PIN')
    expect(wrapper.find('.airplay-pairing__pin input').exists()).toBe(true)
  })
})
