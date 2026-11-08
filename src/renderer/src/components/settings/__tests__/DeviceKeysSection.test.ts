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
  APP_SCOPES: ['history', 'stats', 'now_playing', 'lyrics'],
  createDeviceKey: vi.fn(),
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
  newKey: string
  keys: DeviceKey[]
  label: string
  kind: 'desktop' | 'app'
  shareApiKeys: boolean
  appScopes: string[]
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

  it('shares the API keys only for the device it was confirmed for', async () => {
    vi.mocked(createDeviceKey).mockResolvedValue({ ...EXISTING, id: 'new', key: 'new.secret' })
    const { vm } = await mountSection()

    vm.label = 'Laptop'
    await vm.create()
    expect(createDeviceKey).toHaveBeenLastCalledWith('Laptop', ['sync'])

    vm.label = 'Desktop'
    vm.shareApiKeys = true
    await vm.create()
    expect(createDeviceKey).toHaveBeenLastCalledWith('Desktop', ['sync', 'api_keys'])

    vm.label = 'Tablet'
    await vm.create()
    expect(createDeviceKey).toHaveBeenLastCalledWith('Tablet', ['sync'])
  })

  it('makes an app key with only what was switched on', async () => {
    vi.mocked(createDeviceKey).mockResolvedValue({ ...EXISTING, id: 'new', key: 'new.secret' })
    const { vm } = await mountSection()

    vm.kind = 'app'
    vm.label = 'Display'
    vm.appScopes = ['history', 'stats']
    await vm.create()
    expect(createDeviceKey).toHaveBeenLastCalledWith('Display', ['history', 'stats'])
    expect(vm.appScopes).toEqual([])
  })

  it('takes a right from its switch', async () => {
    vi.mocked(createDeviceKey).mockResolvedValue({ ...EXISTING, id: 'new', key: 'new.secret' })
    const { wrapper, vm } = await mountSection()
    vm.kind = 'app'
    vm.label = 'Display'
    await flushPromises()

    await wrapper.find('input[type="checkbox"]').setValue(true)
    await vm.create()

    expect(createDeviceKey).toHaveBeenLastCalledWith('Display', ['history'])
  })

  it('makes no app key with nothing switched on', async () => {
    const { vm } = await mountSection()
    vm.kind = 'app'
    vm.label = 'Display'
    await vm.create()
    expect(createDeviceKey).not.toHaveBeenCalled()
  })

  it('does not ask for lyrics without what is playing now', async () => {
    vi.mocked(createDeviceKey).mockResolvedValue({ ...EXISTING, id: 'new', key: 'new.secret' })
    const { vm } = await mountSection()
    vm.kind = 'app'
    vm.label = 'Display'
    vm.appScopes = ['history', 'lyrics']
    await vm.create()
    expect(createDeviceKey).toHaveBeenLastCalledWith('Display', ['history'])
  })

  it('never keeps app rights on a key for the desktop', async () => {
    vi.mocked(createDeviceKey).mockResolvedValue({ ...EXISTING, id: 'new', key: 'new.secret' })
    const { vm } = await mountSection()
    vm.kind = 'app'
    vm.appScopes = ['history']
    vm.kind = 'desktop'
    vm.label = 'Laptop'
    await vm.create()
    expect(createDeviceKey).toHaveBeenLastCalledWith('Laptop', ['sync'])
  })

  it('points to the help for the kind of key being made', async () => {
    const { wrapper, emit, vm } = await mountSection()
    const help = wrapper.find('.device-keys__help button')

    await help.trigger('click')
    expect(emit).toHaveBeenLastCalledWith('openHelp', 'guides/desktop-and-server')

    vm.kind = 'app'
    await flushPromises()
    await help.trigger('click')
    expect(emit).toHaveBeenLastCalledWith('openHelp', 'faq/apps-and-api')
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
      active: false,
      scopes: ['sync'],
    })
    const { wrapper, vm } = await mountSection()
    await wrapper.setData({ label: 'Laptop' })
    await vm.create()
    await flushPromises()
    expect(vm.newKey).toBe('two.secret')
    expect(JSON.stringify(vm.keys)).not.toContain('secret')
    expect(vm.keys.map((k) => k.id)).toEqual(['one', 'two'])
  })

  describe('instructions for an AI assistant', () => {
    const writeText = vi.fn()
    const copiedText = () => writeText.mock.lastCall?.[0]

    async function withNewKey(scopes: DeviceKey['scopes']) {
      vi.mocked(createDeviceKey).mockResolvedValue({
        ...EXISTING,
        id: 'new',
        key: 'new.secret',
        scopes,
      })
      const mounted = await mountSection()
      mounted.vm.kind = scopes.includes('sync') ? 'desktop' : 'app'
      mounted.vm.appScopes = scopes
      mounted.vm.label = 'Display'
      await mounted.vm.create()
      await flushPromises()
      return { ...mounted, button: mounted.wrapper.find('.device-keys__for-ai button') }
    }

    beforeEach(() => {
      writeText.mockReset().mockResolvedValue(undefined)
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('never puts the key into them', async () => {
      const { button } = await withNewKey(['history'])
      await button.trigger('click')
      await flushPromises()

      expect(writeText).toHaveBeenCalledOnce()
      expect(copiedText()).toContain('/device-link/v1/openapi.json')
      expect(copiedText()).not.toContain('secret')
    })

    it('describes the key just made, not the switches as they are now', async () => {
      const { button, vm } = await withNewKey(['stats'])
      vm.appScopes = ['history']
      await button.trigger('click')
      await flushPromises()
      expect(copiedText()).not.toContain('next_cursor')
    })

    it('are not offered for a desktop key', async () => {
      const { button } = await withNewKey(['sync'])
      expect(button.exists()).toBe(false)
    })

    it('says where to look when the browser refuses to copy', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      writeText.mockRejectedValue(new Error('no clipboard on http'))
      const { button, emit } = await withNewKey(['history'])
      await button.trigger('click')
      await flushPromises()
      expect(emit).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('/device-link/v1/openapi.json'),
        }),
      )
    })
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
