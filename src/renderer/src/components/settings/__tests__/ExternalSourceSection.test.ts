// The external sources' list in the settings: who sees it, and that each
// row says whether its app answered - not the copy or the layout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { getExternalSources, probeExternalSource } from '@/services/connect/externalSource'
import ExternalSourceSection from '../ExternalSourceSection.vue'

vi.mock('@/services/connect/externalSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/connect/externalSource')>()),
  getExternalSources: vi.fn(),
  probeExternalSource: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })

const SOURCES = [
  { id: 'a', name: 'Wishlist', icon: 'mdi-gift', ui_path: '/x/a/', base_url: 'http://app:8800' },
  { id: 'b', name: 'Folder', icon: 'mdi-web', ui_path: '/x/b/', base_url: 'http://dir:8800' },
]

async function mountSection() {
  const wrapper = mount(ExternalSourceSection, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
      stubs: { ExternalSourceDialog: true },
    },
  })
  await flushPromises()
  return wrapper
}

describe('ExternalSourceSection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getExternalSources).mockResolvedValue({ may_configure: true, sources: SOURCES })
    vi.mocked(probeExternalSource).mockImplementation(async (id) =>
      id === 'a' ? { ok: true } : { ok: false, error: 'refused' },
    )
  })

  afterEach(() => vi.clearAllMocks())

  it('shows nothing to someone who may not change them', async () => {
    vi.mocked(getExternalSources).mockResolvedValue({ may_configure: false, sources: SOURCES })
    const wrapper = await mountSection()
    expect(wrapper.find('section').exists()).toBe(false)
    expect(probeExternalSource).not.toHaveBeenCalled()
  })

  it('asks every app and says which one did not answer', async () => {
    const wrapper = await mountSection()
    expect(probeExternalSource).toHaveBeenCalledWith('a')
    expect(probeExternalSource).toHaveBeenCalledWith('b')
    const rows = wrapper.findAll('.external-sources__row')
    expect(rows[0]!.text()).toContain('http://app:8800')
    expect(rows[1]!.text()).toContain('refused')
  })

  it('opens the dialog for the row that was clicked', async () => {
    const wrapper = await mountSection()
    await wrapper.findAll('.external-sources__row')[1]!.trigger('click')
    const dialog = wrapper.findComponent({ name: 'ExternalSourceDialog' })
    expect(dialog.props('modelValue')).toBe(true)
    expect(dialog.props('source')).toMatchObject({ id: 'b' })
  })
})
