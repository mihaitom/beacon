// Adding, changing and removing an external source: what is sent, that the
// stored token is kept unless a new one is typed, and when the dialog closes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useExternalSourceStore } from '@/stores/externalSource'
import {
  addExternalSource,
  changeExternalSource,
  removeExternalSource,
  type ExternalSource,
} from '@/services/connect/externalSource'
import ExternalSourceDialog from '../ExternalSourceDialog.vue'

vi.mock('@/services/connect/externalSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/connect/externalSource')>()),
  addExternalSource: vi.fn(),
  changeExternalSource: vi.fn(),
  removeExternalSource: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })

const STORED: ExternalSource = {
  id: 'a',
  name: 'Wishlist',
  icon: 'mdi-gift-outline',
  ui_path: '/x/a/',
  base_url: 'http://app:8800',
  has_token: true,
}

type DialogVm = {
  name: string
  icon: string
  baseUrl: string
  token: string
  save: () => Promise<void>
  remove: () => Promise<void>
}

function mountDialog(source: ExternalSource | null) {
  const wrapper = mount(ExternalSourceDialog, {
    props: { modelValue: true, source },
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
    },
  })
  return { wrapper, vm: wrapper.vm as unknown as DialogVm }
}

function saved(source: ExternalSource, ok = true) {
  return { may_configure: true, sources: [source], source, probe: { ok, error: 'refused' } }
}

describe('ExternalSourceDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(changeExternalSource).mockResolvedValue(saved(STORED))
  })

  afterEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('keeps the stored token when none is typed', async () => {
    const { vm } = mountDialog(STORED)
    await vm.save()
    expect(changeExternalSource).toHaveBeenCalledWith('a', {
      name: 'Wishlist',
      icon: 'mdi-gift-outline',
      base_url: 'http://app:8800',
    })
  })

  it('sends a newly typed token and the chosen icon, and updates the tabs', async () => {
    const { wrapper, vm } = mountDialog(STORED)
    vm.name = 'Requests'
    vm.icon = 'mdi-star-outline'
    vm.token = 'new'
    vi.mocked(changeExternalSource).mockResolvedValue(saved({ ...STORED, name: 'Requests' }))
    await vm.save()
    expect(changeExternalSource).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ name: 'Requests', icon: 'mdi-star-outline', token: 'new' }),
    )
    expect(useExternalSourceStore().sources[0]!.name).toBe('Requests')
    expect(vm.token).toBe('')
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('stays open when the app did not answer, and a second save changes what the first added', async () => {
    vi.mocked(addExternalSource).mockResolvedValue(saved(STORED, false))
    const { wrapper, vm } = mountDialog(null)
    vm.name = 'Wishlist'
    vm.baseUrl = 'http://app:8800'
    await vm.save()
    expect(addExternalSource).toHaveBeenCalledOnce()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await flushPromises()
    expect(document.body.textContent).toContain('refused')

    await vm.save()
    expect(addExternalSource).toHaveBeenCalledOnce()
    expect(changeExternalSource).toHaveBeenCalledWith('a', expect.anything())
  })

  it('removes the source and closes', async () => {
    vi.mocked(removeExternalSource).mockResolvedValue({ may_configure: true, sources: [] })
    const store = useExternalSourceStore()
    store.set({ may_configure: true, sources: [STORED] })
    const { wrapper, vm } = mountDialog(STORED)
    await vm.remove()
    expect(removeExternalSource).toHaveBeenCalledWith('a')
    expect(store.sources).toEqual([])
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('starts empty for a new source, with the default icon', async () => {
    const { vm } = mountDialog(null)
    await flushPromises()
    expect([vm.name, vm.baseUrl, vm.icon]).toEqual(['', '', 'mdi-web'])
  })
})
