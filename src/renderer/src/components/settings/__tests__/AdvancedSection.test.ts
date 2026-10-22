// The switch that sends the older Sonos speakers their music at playback
// speed (#56): it shows what connect has, and a change that connect refuses
// is said and not shown as made. Whether the section appears at all is the
// Settings page's own decision, tested there.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { getSonosPacing, setSonosPacing } from '@/services/connect/sonosPacing'
import AdvancedSection from '../AdvancedSection.vue'

vi.mock('@/services/connect/sonosPacing', () => ({
  getSonosPacing: vi.fn(),
  setSonosPacing: vi.fn(),
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

function olderSonosSwitch(wrapper: Awaited<ReturnType<typeof mountSection>>['wrapper']) {
  const label = wrapper.vm.$t('settings.olderSonosPaced')
  return wrapper.findAllComponents({ name: 'VSwitch' }).find((c) => c.props('label') === label)!
}

describe('AdvancedSection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getSonosPacing).mockReset().mockResolvedValue({ paced: false })
    vi.mocked(setSonosPacing).mockReset().mockResolvedValue(undefined)
  })

  it('shows what connect has for the older Sonos speakers', async () => {
    vi.mocked(getSonosPacing).mockResolvedValue({ paced: true })
    const { wrapper } = await mountSection()

    expect(olderSonosSwitch(wrapper).props('modelValue')).toBe(true)
  })

  it('switches the older Sonos speakers to playback speed', async () => {
    const { wrapper } = await mountSection()

    await olderSonosSwitch(wrapper).vm.$emit('update:modelValue', true)
    await flushPromises()

    expect(setSonosPacing).toHaveBeenCalledWith(true)
    expect(olderSonosSwitch(wrapper).props('modelValue')).toBe(true)
  })

  it('says so and stays as it was when connect refuses the change', async () => {
    vi.mocked(setSonosPacing).mockRejectedValue(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { wrapper, emit } = await mountSection()

    await olderSonosSwitch(wrapper).vm.$emit('update:modelValue', true)
    await flushPromises()

    expect(olderSonosSwitch(wrapper).props('modelValue')).toBe(false)
    expect(emit).toHaveBeenCalledWith('toast', expect.objectContaining({ level: 'error' }))
  })
})
