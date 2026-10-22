// How the older Sonos speakers get a song (#56): the choice shows what
// connect has, and a change that connect refuses is said and not shown as
// made. Whether the section appears at all is the Settings page's own
// decision, tested there.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { getOlderSonosMode, setOlderSonosMode } from '@/services/connect/olderSonos'
import AdvancedSection from '../AdvancedSection.vue'

vi.mock('@/services/connect/olderSonos', () => ({
  getOlderSonosMode: vi.fn(),
  setOlderSonosMode: vi.fn(),
}))
vi.mock('@/services/connect/logLevel', () => ({
  getLogLevel: vi.fn(async () => ({ level: 'INFO', levels: [] })),
  setLogLevel: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })

async function mountSection() {
  const auth = useAuthStore()
  auth.isAdmin = true
  auth.serverType = 'subsonic'
  const emit = vi.fn()
  const wrapper = mount(AdvancedSection, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit, on: vi.fn(), off: vi.fn() } },
    },
  })
  await flushPromises()
  return { wrapper, emit }
}

function olderSonosSelect(wrapper: Awaited<ReturnType<typeof mountSection>>['wrapper']) {
  const label = wrapper.vm.$t('settings.olderSonosMode')
  return wrapper.findAllComponents({ name: 'VSelect' }).find((c) => c.props('label') === label)!
}

describe('AdvancedSection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getOlderSonosMode).mockReset().mockResolvedValue({ mode: 'whole' })
    vi.mocked(setOlderSonosMode).mockReset().mockResolvedValue(undefined)
  })

  it('shows what connect has for the older Sonos speakers', async () => {
    vi.mocked(getOlderSonosMode).mockResolvedValue({ mode: 'file' })
    const { wrapper } = await mountSection()

    expect(olderSonosSelect(wrapper).props('modelValue')).toBe('file')
  })

  it('switches the older Sonos speakers to another way', async () => {
    const { wrapper } = await mountSection()

    await olderSonosSelect(wrapper).vm.$emit('update:modelValue', 'paced')
    await flushPromises()

    expect(setOlderSonosMode).toHaveBeenCalledWith('paced')
    expect(olderSonosSelect(wrapper).props('modelValue')).toBe('paced')
  })

  it('says so and stays as it was when connect refuses the change', async () => {
    vi.mocked(setOlderSonosMode).mockRejectedValue(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { wrapper, emit } = await mountSection()

    await olderSonosSelect(wrapper).vm.$emit('update:modelValue', 'paced')
    await flushPromises()

    expect(olderSonosSelect(wrapper).props('modelValue')).toBe('whole')
    expect(emit).toHaveBeenCalledWith('toast', expect.objectContaining({ level: 'error' }))
  })
})
