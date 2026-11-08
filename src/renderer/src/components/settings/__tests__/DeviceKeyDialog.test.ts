// Making a key: what it may do is chosen here, and the key exists on screen
// exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import DeviceKeyDialog from '../DeviceKeyDialog.vue'
import { createDeviceKey, type DeviceKey } from '@/services/connect/serverLink'

vi.mock('@/services/connect/serverLink', () => ({
  APP_SCOPES: ['history', 'stats', 'now_playing', 'lyrics'],
  createDeviceKey: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })
const CREATED: DeviceKey & { key: string } = {
  id: 'new',
  key: 'new.secret',
  label: 'Laptop',
  created_at: 2,
  last_used_at: null,
  active: false,
  scopes: ['sync'],
}

type Vm = {
  newKey: string
  label: string
  kind: 'desktop' | 'app'
  shareApiKeys: boolean
  appScopes: string[]
  create(): Promise<void>
}

// Teleported otherwise, out of the wrapper's reach.
const INLINE_DIALOG = {
  props: ['persistent'],
  template: '<div class="stub-dialog" :data-persistent="persistent"><slot /></div>',
}

function mountDialog(attachTo?: HTMLElement) {
  const emit = vi.fn()
  const wrapper = mount(DeviceKeyDialog, {
    attachTo,
    props: { modelValue: true },
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit, on: vi.fn(), off: vi.fn() } },
      stubs: { VDialog: INLINE_DIALOG },
    },
  })
  return { wrapper, emit, vm: wrapper.vm as unknown as Vm }
}

async function reopen(wrapper: ReturnType<typeof mountDialog>['wrapper']) {
  await wrapper.setProps({ modelValue: false })
  await wrapper.setProps({ modelValue: true })
}

describe('DeviceKeyDialog', () => {
  beforeEach(() => {
    vi.mocked(createDeviceKey).mockReset().mockResolvedValue(CREATED)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shares the API keys only for the device it was confirmed for', async () => {
    const { wrapper, vm } = mountDialog()

    vm.label = 'Desktop'
    vm.shareApiKeys = true
    await vm.create()
    expect(createDeviceKey).toHaveBeenLastCalledWith('Desktop', ['sync', 'api_keys'])

    await reopen(wrapper)
    vm.label = 'Tablet'
    await vm.create()
    expect(createDeviceKey).toHaveBeenLastCalledWith('Tablet', ['sync'])
  })

  it('makes an app key with only what was switched on', async () => {
    const { vm } = mountDialog()
    vm.kind = 'app'
    vm.appScopes = ['history']
    vm.label = 'Display'
    await vm.create()
    expect(createDeviceKey).toHaveBeenCalledWith('Display', ['history'])
  })

  it('switches a right from anywhere on its row', async () => {
    // Attached: a checkbox outside the document fires no change event.
    const { wrapper, vm } = mountDialog(document.body)
    vm.kind = 'app'
    await wrapper.vm.$nextTick()

    ;(wrapper.find('.device-key-dialog__row').element as HTMLElement).click()
    await wrapper.vm.$nextTick()

    expect(vm.appScopes).toEqual(['history'])
    wrapper.unmount()
  })

  it('makes no app key with nothing switched on', async () => {
    const { vm } = mountDialog()
    vm.kind = 'app'
    vm.label = 'Display'
    await vm.create()
    expect(createDeviceKey).not.toHaveBeenCalled()
  })

  it('does not ask for lyrics without what is playing now', async () => {
    const { vm } = mountDialog()
    vm.kind = 'app'
    vm.appScopes = ['history', 'lyrics']
    vm.label = 'Display'
    await vm.create()
    expect(createDeviceKey).toHaveBeenCalledWith('Display', ['history'])
  })

  it('never keeps app rights on a key for the desktop', async () => {
    const { vm } = mountDialog()
    vm.kind = 'app'
    vm.appScopes = ['history']
    vm.kind = 'desktop'
    vm.label = 'Laptop'
    await vm.create()
    expect(createDeviceKey).toHaveBeenCalledWith('Laptop', ['sync'])
  })

  it('does not create a key without a name', async () => {
    const { vm } = mountDialog()
    vm.label = '   '
    await vm.create()
    expect(createDeviceKey).not.toHaveBeenCalled()
  })

  it('points to the help for the kind of key being made', async () => {
    const { wrapper, vm, emit } = mountDialog()
    await wrapper.find('.device-key-dialog__help').trigger('click')
    expect(emit).toHaveBeenLastCalledWith('openHelp', 'guides/desktop-and-server')

    vm.kind = 'app'
    await wrapper.vm.$nextTick()
    await wrapper.find('.device-key-dialog__help').trigger('click')
    expect(emit).toHaveBeenLastCalledWith('openHelp', 'faq/apps-and-api')
  })

  it('shows a new key and passes it on without the secret', async () => {
    const { wrapper, vm } = mountDialog()
    vm.label = 'Laptop'
    await vm.create()
    await flushPromises()

    expect(vm.newKey).toBe('new.secret')
    expect(wrapper.find('.device-key-dialog__secret').text()).toBe('new.secret')
    const [[entry]] = wrapper.emitted('created') as [[DeviceKey]]
    expect(entry.id).toBe('new')
    expect(JSON.stringify(entry)).not.toContain('secret')
  })

  it('cannot be dismissed by accident while the key is on screen', async () => {
    const { wrapper, vm } = mountDialog()
    expect(wrapper.find('.stub-dialog').attributes('data-persistent')).toBe('false')
    vm.label = 'Laptop'
    await vm.create()
    await flushPromises()
    expect(wrapper.find('.stub-dialog').attributes('data-persistent')).toBe('true')
  })

  it('does not show a key again when opened for the next one', async () => {
    const { wrapper, vm } = mountDialog()
    vm.label = 'Laptop'
    await vm.create()
    await flushPromises()

    await reopen(wrapper)

    expect(vm.newKey).toBe('')
    expect(wrapper.html()).not.toContain('new.secret')
  })

  it('stays on the form when the key could not be made', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createDeviceKey).mockRejectedValue(new Error('offline'))
    const { wrapper, vm, emit } = mountDialog()
    vm.label = 'Laptop'
    await vm.create()
    await flushPromises()

    expect(vm.newKey).toBe('')
    expect(wrapper.emitted('created')).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('toast', expect.objectContaining({ level: 'error' }))
  })

  describe('instructions for an AI assistant', () => {
    const writeText = vi.fn()
    const copiedText = () => writeText.mock.lastCall?.[0]

    async function withNewKey(scopes: DeviceKey['scopes']) {
      vi.mocked(createDeviceKey).mockResolvedValue({ ...CREATED, scopes })
      const mounted = mountDialog()
      mounted.vm.kind = scopes.includes('sync') ? 'desktop' : 'app'
      mounted.vm.appScopes = scopes
      mounted.vm.label = 'Display'
      await mounted.vm.create()
      await flushPromises()
      return { ...mounted, button: mounted.wrapper.find('.device-key-dialog__for-ai button') }
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
})
