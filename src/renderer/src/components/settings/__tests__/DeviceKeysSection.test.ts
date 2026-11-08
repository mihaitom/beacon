// The server's side of pairing: a key exists on screen once, and revoking
// one takes it away.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import DeviceKeysSection from '../DeviceKeysSection.vue'
import {
  createDeviceKey,
  listDeviceKeys,
  revokeDeviceKey,
  type DeviceKey,
} from '@/services/connect/serverLink'

vi.mock('@/services/connect/serverLink', () => ({
  createDeviceKey: vi.fn(),
  listDeviceKeys: vi.fn(),
  revokeDeviceKey: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })
const EXISTING: DeviceKey = { id: 'one', label: 'Old laptop', created_at: 1, last_used_at: null }

type Vm = {
  newKey: string
  keys: DeviceKey[]
  create(): Promise<void>
  revoke(entry: DeviceKey): Promise<void>
}

async function mountSection() {
  const emit = vi.fn()
  const wrapper = mount(DeviceKeysSection, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit, on: vi.fn(), off: vi.fn() } },
    },
  })
  await flushPromises()
  return { wrapper, emit, vm: wrapper.vm as unknown as Vm }
}

describe('DeviceKeysSection', () => {
  beforeEach(() => {
    vi.mocked(listDeviceKeys).mockReset().mockResolvedValue([EXISTING])
    vi.mocked(createDeviceKey).mockReset()
    vi.mocked(revokeDeviceKey).mockReset().mockResolvedValue({})
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('is not offered in the desktop app', async () => {
    ;(window as unknown as { api: unknown }).api = {}
    const { wrapper } = await mountSection()
    expect(wrapper.find('section').exists()).toBe(false)
    expect(listDeviceKeys).not.toHaveBeenCalled()
  })

  it('shows a new key and adds it to the list without keeping it there', async () => {
    vi.mocked(createDeviceKey).mockResolvedValue({
      id: 'two',
      key: 'two.secret',
      label: 'Laptop',
      created_at: 2,
      last_used_at: null,
    })
    const { wrapper, vm } = await mountSection()
    await wrapper.setData({ label: 'Laptop' })
    await vm.create()
    await flushPromises()
    expect(vm.newKey).toBe('two.secret')
    expect(JSON.stringify(vm.keys)).not.toContain('secret')
    expect(vm.keys.map((k) => k.id)).toEqual(['one', 'two'])
  })

  it('does not create a key without a name', async () => {
    const { wrapper, vm } = await mountSection()
    await wrapper.setData({ label: '   ' })
    await vm.create()
    expect(createDeviceKey).not.toHaveBeenCalled()
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
