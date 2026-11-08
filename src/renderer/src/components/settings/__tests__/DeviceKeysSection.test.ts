// The server's side of pairing: a key exists on screen once, and revoking
// one takes it away.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import DeviceKeyDialog from '../DeviceKeyDialog.vue'
import DeviceKeysSection from '../DeviceKeysSection.vue'
import { listDeviceKeys, revokeDeviceKey, type DeviceKey } from '@/services/connect/serverLink'

vi.mock('@/services/connect/serverLink', () => ({
  APP_SCOPES: ['history', 'stats', 'now_playing', 'lyrics'],
  listDeviceKeys: vi.fn(),
  revokeDeviceKey: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })
const EXISTING: DeviceKey = {
  id: 'one',
  label: 'Old laptop',
  created_at: 1,
  last_used_at: null,
  active: false,
  scopes: ['sync'],
}

type Vm = {
  keys: DeviceKey[]
  revoke(entry: DeviceKey): Promise<void>
}

async function mountSection() {
  const emit = vi.fn()
  const wrapper = mount(DeviceKeysSection, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit, on: vi.fn(), off: vi.fn() } },
      stubs: { DeviceKeyDialog: true },
    },
  })
  await flushPromises()
  return { wrapper, emit, vm: wrapper.vm as unknown as Vm }
}

describe('DeviceKeysSection', () => {
  beforeEach(() => {
    vi.mocked(listDeviceKeys).mockReset().mockResolvedValue([EXISTING])
    vi.mocked(revokeDeviceKey).mockReset().mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
  })

  it('shows a device connecting without a reload', async () => {
    vi.useFakeTimers()
    const { wrapper } = await mountSection()
    expect(wrapper.text()).not.toContain(i18n.global.t('settings.deviceKeysConnected'))

    vi.mocked(listDeviceKeys).mockResolvedValue([{ ...EXISTING, last_used_at: 5, active: true }])
    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()

    expect(wrapper.text()).toContain(i18n.global.t('settings.deviceKeysConnected'))
    expect(wrapper.find('.status-dot--ok').exists()).toBe(true)
    wrapper.unmount()
  })

  it('says what each key may do', async () => {
    vi.mocked(listDeviceKeys).mockResolvedValue([
      { ...EXISTING, id: 'a', scopes: ['sync', 'api_keys'] },
      { ...EXISTING, id: 'b', scopes: ['history'] },
    ])
    const { wrapper } = await mountSection()
    expect(wrapper.text()).toContain(i18n.global.t('settings.deviceKeysSharesApi'))
    expect(wrapper.text()).toContain(i18n.global.t('settings.deviceKeysScope_history'))
  })

  it('stops asking once it is gone', async () => {
    vi.useFakeTimers()
    const { wrapper } = await mountSection()
    wrapper.unmount()
    vi.mocked(listDeviceKeys).mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listDeviceKeys).not.toHaveBeenCalled()
  })

  it('does not bring a revoked key back from a list asked for earlier', async () => {
    const { vm } = await mountSection()
    let answer: (keys: DeviceKey[]) => void = () => {}
    vi.mocked(listDeviceKeys).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      }),
    )
    const refresh = (vm as unknown as { load(): Promise<void> }).load()
    await vm.revoke(EXISTING)
    answer([EXISTING])
    await refresh
    expect(vm.keys).toEqual([])
  })

  it('opens the dialog for a new key', async () => {
    const { wrapper } = await mountSection()
    const dialog = wrapper.findComponent(DeviceKeyDialog)
    expect(dialog.props('modelValue')).toBe(false)

    await wrapper.find('.device-keys__head button').trigger('click')

    expect(dialog.props('modelValue')).toBe(true)
  })

  it('lists a new key at once, and an older answer does not take it away', async () => {
    const { wrapper, vm } = await mountSection()
    let answer: (keys: DeviceKey[]) => void = () => {}
    vi.mocked(listDeviceKeys).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      }),
    )
    const refresh = (vm as unknown as { load(): Promise<void> }).load()

    wrapper.findComponent(DeviceKeyDialog).vm.$emit('created', { ...EXISTING, id: 'two' })
    answer([EXISTING])
    await refresh

    expect(vm.keys.map((key) => key.id)).toEqual(['one', 'two'])
  })

  it('is not offered in the desktop app', async () => {
    ;(window as unknown as { api: unknown }).api = {}
    const { wrapper } = await mountSection()
    expect(wrapper.find('section').exists()).toBe(false)
    expect(listDeviceKeys).not.toHaveBeenCalled()
  })

  it('removes a revoked key', async () => {
    const { vm } = await mountSection()
    await vm.revoke(EXISTING)
    await flushPromises()
    expect(revokeDeviceKey).toHaveBeenCalledWith('one')
    expect(vm.keys).toEqual([])
  })

  it('keeps a key whose revocation failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(revokeDeviceKey).mockRejectedValue(new Error('offline'))
    const { vm, emit } = await mountSection()
    await vm.revoke(EXISTING)
    await flushPromises()
    expect(vm.keys).toEqual([EXISTING])
    expect(emit).toHaveBeenCalledWith('toast', expect.objectContaining({ level: 'error' }))
  })
})
