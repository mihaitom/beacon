// The installation-wide API key section: one row per external service, what
// it sends, what it shows, and how somebody without a key is told where to
// get one. Whether the section appears at all is the Settings page's own
// decision, tested there.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLastfmStore } from '@/stores/lastfm'
import { getApiKeyStatuses, setApiKey, type ApiKeyStatuses } from '@/services/connect/apiKeys'
import ApiKeysSection from '../ApiKeysSection.vue'

vi.mock('@/services/connect/apiKeys', () => ({
  getApiKeyStatuses: vi.fn(),
  setApiKey: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })

const NONE_SET: ApiKeyStatuses = {
  lastfm: { configured: false, fromEnvironment: false },
  fanart: { configured: false, fromEnvironment: false },
}

function statuses(overrides: Partial<ApiKeyStatuses['lastfm']> = {}): ApiKeyStatuses {
  return { ...NONE_SET, lastfm: { configured: false, fromEnvironment: false, ...overrides } }
}

async function mountSection() {
  const wrapper = mount(ApiKeysSection, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
    },
  })
  await flushPromises()
  return wrapper
}

function keyField(wrapper: Awaited<ReturnType<typeof mountSection>>, service = 'Last.fm') {
  const label = wrapper.vm.$t('settings.apiKeyLabel', { service })
  return wrapper.findAllComponents({ name: 'VTextField' }).find((c) => c.props('label') === label)
}

describe('ApiKeysSection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(getApiKeyStatuses).mockReset().mockResolvedValue(NONE_SET)
    vi.mocked(setApiKey)
      .mockReset()
      .mockResolvedValue(statuses({ configured: true }))
  })

  it('saves a pasted key and makes the builder available', async () => {
    const wrapper = await mountSection()

    const field = keyField(wrapper)!
    await field.vm.$emit('update:modelValue', '  abc123  ')
    await (wrapper.vm as unknown as { saveKey: (id: string) => Promise<void> }).saveKey('lastfm')
    await flushPromises()

    // Trimmed: a key pasted out of a browser routinely brings whitespace.
    expect(setApiKey).toHaveBeenCalledWith('lastfm', 'abc123')
    // Without this the playlist builder would stay hidden until a reload.
    expect(useLastfmStore().configured).toBe(true)
  })

  it('clears the field after saving, since the key is never read back', async () => {
    const wrapper = await mountSection()

    const vm = wrapper.vm as unknown as {
      keyInput: Record<string, string>
      saveKey: (id: string) => Promise<void>
    }
    vm.keyInput.lastfm = 'abc123'
    await vm.saveKey('lastfm')
    await flushPromises()

    expect(vm.keyInput.lastfm).toBe('')
  })

  it('does not send an empty key as a save', async () => {
    const wrapper = await mountSection()

    const vm = wrapper.vm as unknown as {
      keyInput: Record<string, string>
      saveKey: (id: string) => Promise<void>
    }
    vm.keyInput.lastfm = '   '
    await vm.saveKey('lastfm')

    expect(setApiKey).not.toHaveBeenCalled()
  })

  it('clearing the key sends an empty one and hides the builder again', async () => {
    vi.mocked(setApiKey).mockResolvedValue(NONE_SET)
    const wrapper = await mountSection()

    await (wrapper.vm as unknown as { clearKey: (id: string) => Promise<void> }).clearKey('lastfm')
    await flushPromises()

    expect(setApiKey).toHaveBeenCalledWith('lastfm', '')
    expect(useLastfmStore().configured).toBe(false)
  })

  it('says a key from the deployment is in use rather than looking unconfigured', async () => {
    // Docker sets LASTFM_API_KEY; the field is empty because the backend
    // never hands a key back, which would otherwise read as "no key".
    vi.mocked(getApiKeyStatuses).mockResolvedValue(
      statuses({ configured: true, fromEnvironment: true }),
    )
    const wrapper = await mountSection()

    expect(wrapper.text()).toContain(wrapper.vm.$t('settings.apiKeyFromEnvironment'))
  })

  it('offers no remove button for a key that comes from the deployment', async () => {
    // Removing it would do nothing - the environment's key stays in
    // effect, so the button would look broken.
    vi.mocked(getApiKeyStatuses).mockResolvedValue(
      statuses({ configured: true, fromEnvironment: true }),
    )
    const wrapper = await mountSection()

    expect(wrapper.text()).not.toContain(wrapper.vm.$t('settings.apiKeyClear'))
  })

  it('puts the how-to-get-a-key steps behind the info button, not under the field', async () => {
    const wrapper = await mountSection()

    expect(wrapper.text()).not.toContain(wrapper.vm.$t('settings.lastfmStep2'))
    const tips = wrapper
      .findAllComponents({ name: 'QualityTips' })
      .find((c) => (c.props('lines') as string[]).includes(wrapper.vm.$t('settings.lastfmStep2')))
    expect(tips).toBeDefined()
    // All four, in the order the registration form asks for them.
    expect(tips!.props('lines')).toEqual([
      wrapper.vm.$t('settings.lastfmStep1'),
      wrapper.vm.$t('settings.lastfmStep2'),
      wrapper.vm.$t('settings.lastfmStep3'),
      wrapper.vm.$t('settings.lastfmStep4'),
    ])
  })

  it('links straight to where each key is requested', async () => {
    const wrapper = await mountSection()

    const links = wrapper.findAll('a')
    const lastfm = links.find(
      (a) => a.attributes('href') === 'https://www.last.fm/api/account/create',
    )
    const fanart = links.find((a) => a.attributes('href') === 'https://fanart.tv/get-an-api-key/')
    expect(lastfm?.text()).toContain(wrapper.vm.$t('settings.apiKeyGet'))
    expect(fanart?.text()).toContain(wrapper.vm.$t('settings.apiKeyGet'))
    // Opening an external page must not be able to reach back into the app.
    expect(lastfm?.attributes('rel')).toContain('noopener')
  })

  it('offers a row for every keyed service', async () => {
    const wrapper = await mountSection()

    expect(keyField(wrapper, wrapper.vm.$t('settings.lastfmTitle'))).toBeDefined()
    expect(keyField(wrapper, wrapper.vm.$t('settings.fanartTitle'))).toBeDefined()
  })

  it('shows at a glance whether a key is set', async () => {
    vi.mocked(getApiKeyStatuses).mockResolvedValue(statuses({ configured: true }))
    const wrapper = await mountSection()

    expect(wrapper.find('.status-dot--ok').exists()).toBe(true)
    expect(wrapper.find('.status-dot--warn').exists()).toBe(true)
  })

  it('still lets a key be entered when the status check fails', async () => {
    // connect briefly unreachable must not leave a section that cannot be
    // used - entering a key is exactly what would fix it.
    vi.mocked(getApiKeyStatuses).mockRejectedValue(new Error('offline'))
    const wrapper = await mountSection()

    expect(keyField(wrapper)).toBeDefined()
    expect(wrapper.find('.status-dot--warn').exists()).toBe(true)
  })
})
