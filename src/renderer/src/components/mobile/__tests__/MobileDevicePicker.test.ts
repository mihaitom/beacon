import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import { VBtn } from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useConnectStore } from '@/stores/connect'
import MobileDevicePicker from '../MobileDevicePicker.vue'

const vuetify = createVuetify({ components, directives })

// v-bottom-sheet teleports its content to the document body, so the usual
// wrapper queries find nothing — attaching to the document and querying it
// directly is what actually reaches the rendered sheet.
function mountPicker() {
  return mount(MobileDevicePicker, {
    props: { modelValue: true },
    attachTo: document.body,
    global: { plugins: [vuetify, i18n] },
  })
}

function rescanButton(wrapper: ReturnType<typeof mountPicker>) {
  return wrapper.getComponent<typeof VBtn>('.mobile-device-picker__rescan')
}

describe('MobileDevicePicker', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('kicks off a fresh scan from the rescan button, and locks it while one runs', async () => {
    const connect = useConnectStore()
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()
    const refreshSpy = vi.spyOn(connect, 'refreshDevices').mockResolvedValue()

    const rescan = rescanButton(wrapper)
    expect(rescan.props('icon')).toBe('mdi-refresh')

    await rescan.trigger('click')
    expect(refreshSpy).toHaveBeenCalledWith(true)

    // Same reason as ConnectDevicePicker.vue's: overlapping scans would let
    // the first one to return clear isScanning while the second still runs.
    connect.isScanning = true
    await wrapper.vm.$nextTick()

    expect(rescan.props('loading')).toBe(true)
    expect(rescan.props('disabled')).toBe(true)
  })
})
