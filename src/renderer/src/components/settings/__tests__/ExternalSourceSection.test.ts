// The external source's settings: who sees them, and that the stored token
// is kept unless a new one is typed - not the copy or the layout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useExternalSourceStore } from '@/stores/externalSource'
import {
  getExternalSource,
  probeExternalSource,
  saveExternalSource,
} from '@/services/connect/externalSource'
import ExternalSourceSection from '../ExternalSourceSection.vue'

vi.mock('@/services/connect/externalSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/connect/externalSource')>()),
  getExternalSource: vi.fn(),
  probeExternalSource: vi.fn(),
  saveExternalSource: vi.fn(),
  removeExternalSource: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })

async function mountSection() {
  const wrapper = mount(ExternalSourceSection, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
    },
  })
  await flushPromises()
  return wrapper
}

type SectionVm = { name: string; baseUrl: string; token: string; save: () => Promise<void> }

const CONFIGURED = {
  configured: true,
  may_configure: true,
  name: 'Wishlist',
  base_url: 'http://app:8800',
  has_token: true,
  ui_path: '/external-ui/s/',
}

describe('ExternalSourceSection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getExternalSource).mockResolvedValue(CONFIGURED)
    vi.mocked(probeExternalSource).mockResolvedValue({ ok: true, name: 'Wishlist' })
    vi.mocked(saveExternalSource).mockResolvedValue({ ...CONFIGURED, probe: { ok: true } })
  })

  afterEach(() => vi.clearAllMocks())

  it('shows nothing to someone who may not change it', async () => {
    vi.mocked(getExternalSource).mockResolvedValue({ configured: true, may_configure: false })
    const wrapper = await mountSection()
    expect(wrapper.find('section').exists()).toBe(false)
  })

  it('keeps the stored token when none is typed', async () => {
    const wrapper = await mountSection()
    const vm = wrapper.vm as unknown as SectionVm
    expect(vm.name).toBe('Wishlist')
    await vm.save()
    expect(saveExternalSource).toHaveBeenCalledWith({
      name: 'Wishlist',
      base_url: 'http://app:8800',
    })
  })

  it('sends a newly typed token and updates the tab', async () => {
    const wrapper = await mountSection()
    const vm = wrapper.vm as unknown as SectionVm
    vm.name = 'Requests'
    vm.token = 'new'
    vi.mocked(saveExternalSource).mockResolvedValue({
      ...CONFIGURED,
      name: 'Requests',
      probe: { ok: true },
    })
    await vm.save()
    expect(saveExternalSource).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Requests', token: 'new' }),
    )
    expect(useExternalSourceStore().name).toBe('Requests')
    expect(vm.token).toBe('')
  })
})
