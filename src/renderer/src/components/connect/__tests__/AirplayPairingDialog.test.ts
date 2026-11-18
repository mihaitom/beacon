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
  // Vuetify 4's OTP field is one input behind the boxes.
  await wrapper.get('.airplay-pairing__pin .v-otp-input__input').setValue(pin)
  await flushPromises()
}

describe('AirplayPairingDialog', () => {
  let store: ReturnType<typeof useConnectStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useConnectStore()
  })

  it('pairs with the PIN the device shows once all four digits are in', async () => {
    vi.spyOn(store, 'startPairing').mockResolvedValue({ device_provides_pin: true } as never)
    const finish = vi.spyOn(store, 'finishPairing').mockResolvedValue()
    const wrapper = await openDialog()

    await typePin(wrapper, '0427')

    expect(finish).toHaveBeenCalledWith('Living Room', 427)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
  })

  it('holds Done back until the PIN is complete', async () => {
    vi.spyOn(store, 'startPairing').mockResolvedValue({ device_provides_pin: true } as never)
    const wrapper = await openDialog()

    await typePin(wrapper, '04')

    expect(button(wrapper, 'Done')?.attributes('disabled')).toBeDefined()
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
    expect(wrapper.text()).toContain('Incorrect PIN')

    await button(wrapper, 'Retry')!.trigger('click')
    await flushPromises()

    expect(start).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('Incorrect PIN')
    expect(wrapper.find('.airplay-pairing__pin .v-otp-input__input').exists()).toBe(true)
  })
})
