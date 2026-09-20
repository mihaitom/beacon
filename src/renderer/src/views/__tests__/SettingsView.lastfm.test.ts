// The advanced-features switch and the Last.fm API key field behind it.
// The switch exists so the person who did not set the music server up
// never meets the setup controls; the key field is the first thing it
// covers, and the one that makes the playlist builder appear at all.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAdvancedModeStore } from '@/stores/advancedMode'
import { useLastfmStore } from '@/stores/lastfm'
import { getLastfmStatus, setLastfmApiKey } from '@/services/connect/lastfm'
import SettingsView from '../SettingsView.vue'

vi.mock('@/services/connect/lastfm', () => ({
  getLastfmStatus: vi.fn().mockResolvedValue({ configured: false, fromEnvironment: false }),
  setLastfmApiKey: vi.fn().mockResolvedValue({ configured: true, fromEnvironment: false }),
}))

const vuetify = createVuetify({ components, directives })

async function mountSettings() {
  const wrapper = mount(SettingsView, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
      stubs: { ConnectButton: true, RemoteControlButton: true },
    },
  })
  await flushPromises()
  return wrapper
}

function advancedToggle(wrapper: Awaited<ReturnType<typeof mountSettings>>) {
  const label = wrapper.vm.$t('settings.advancedMode')
  const toggle = wrapper
    .findAllComponents({ name: 'VSwitch' })
    .find((c) => c.text().includes(label))
  if (!toggle) throw new Error('advanced-mode toggle not found')
  return toggle
}

function keyField(wrapper: Awaited<ReturnType<typeof mountSettings>>) {
  const label = wrapper.vm.$t('settings.lastfmKey')
  return wrapper.findAllComponents({ name: 'VTextField' }).find((c) => c.props('label') === label)
}

describe('SettingsView advanced features', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(getLastfmStatus).mockReset()
    vi.mocked(setLastfmApiKey).mockReset()
    vi.mocked(getLastfmStatus).mockResolvedValue({ configured: false, fromEnvironment: false })
    vi.mocked(setLastfmApiKey).mockResolvedValue({ configured: true, fromEnvironment: false })
  })

  it('hides the whole Last.fm section until advanced features are switched on', async () => {
    // The section, not just the control inside it: a heading with nothing
    // under it is what gating one field at a time leaves behind.
    const wrapper = await mountSettings()
    const headings = () => wrapper.findAll('.section-title').map((h) => h.text())

    expect(keyField(wrapper)).toBeUndefined()
    expect(headings()).not.toContain(wrapper.vm.$t('settings.lastfmTitle'))

    await advancedToggle(wrapper).vm.$emit('update:modelValue', true)
    await flushPromises()

    expect(keyField(wrapper)).toBeDefined()
    expect(headings()).toContain(wrapper.vm.$t('settings.lastfmTitle'))
  })

  it('keeps the switch itself in the Advanced section, where it can be found', async () => {
    // The switch must not hide with what it reveals, or nothing could
    // ever turn it back on.
    const wrapper = await mountSettings()
    const headings = wrapper.findAll('.section-title').map((h) => h.text())

    expect(headings).toContain(wrapper.vm.$t('settings.advancedTitle'))
    expect(advancedToggle(wrapper).exists()).toBe(true)
  })

  it('offers the switch itself to everyone, so it can be found', async () => {
    const wrapper = await mountSettings()
    expect(advancedToggle(wrapper).props('modelValue')).toBe(false)
  })

  it('saves a pasted key and makes the builder available', async () => {
    const wrapper = await mountSettings()
    useAdvancedModeStore().setEnabled(true)
    await flushPromises()

    const field = keyField(wrapper)!
    await field.vm.$emit('update:modelValue', '  abc123  ')
    await (wrapper.vm as unknown as { saveLastfmKey: () => Promise<void> }).saveLastfmKey()
    await flushPromises()

    // Trimmed: a key pasted out of a browser routinely brings whitespace.
    expect(setLastfmApiKey).toHaveBeenCalledWith('abc123')
    // Without this the playlist builder would stay hidden until a reload.
    expect(useLastfmStore().configured).toBe(true)
  })

  it('clears the field after saving, since the key is never read back', async () => {
    const wrapper = await mountSettings()
    useAdvancedModeStore().setEnabled(true)
    await flushPromises()

    const vm = wrapper.vm as unknown as { lastfmKey: string; saveLastfmKey: () => Promise<void> }
    vm.lastfmKey = 'abc123'
    await vm.saveLastfmKey()
    await flushPromises()

    expect(vm.lastfmKey).toBe('')
  })

  it('does not send an empty key as a save', async () => {
    const wrapper = await mountSettings()
    useAdvancedModeStore().setEnabled(true)
    await flushPromises()

    const vm = wrapper.vm as unknown as { lastfmKey: string; saveLastfmKey: () => Promise<void> }
    vm.lastfmKey = '   '
    await vm.saveLastfmKey()

    expect(setLastfmApiKey).not.toHaveBeenCalled()
  })

  it('clearing the key sends an empty one and hides the builder again', async () => {
    vi.mocked(setLastfmApiKey).mockResolvedValue({ configured: false, fromEnvironment: false })
    const wrapper = await mountSettings()
    useAdvancedModeStore().setEnabled(true)
    await flushPromises()

    await (wrapper.vm as unknown as { clearLastfmKey: () => Promise<void> }).clearLastfmKey()
    await flushPromises()

    expect(setLastfmApiKey).toHaveBeenCalledWith('')
    expect(useLastfmStore().configured).toBe(false)
  })

  it('says a key from the deployment is in use rather than looking unconfigured', async () => {
    // Docker sets LASTFM_API_KEY; the field is empty because the backend
    // never hands a key back, which would otherwise read as "no key".
    vi.mocked(getLastfmStatus).mockResolvedValue({ configured: true, fromEnvironment: true })
    const wrapper = await mountSettings()
    useAdvancedModeStore().setEnabled(true)
    await flushPromises()

    expect(wrapper.text()).toContain(wrapper.vm.$t('settings.lastfmKeyFromEnvironment'))
  })

  it('offers no remove button for a key that comes from the deployment', async () => {
    // Removing it would do nothing - the environment's key stays in
    // effect, so the button would look broken.
    vi.mocked(getLastfmStatus).mockResolvedValue({ configured: true, fromEnvironment: true })
    const wrapper = await mountSettings()
    useAdvancedModeStore().setEnabled(true)
    await flushPromises()

    expect(wrapper.text()).not.toContain(wrapper.vm.$t('settings.lastfmKeyClear'))
  })

  it('puts the how-to-get-a-key steps behind the info button, not under the field', async () => {
    // Five lines of instructions that stop being interesting the moment
    // somebody has a key - a permanent paragraph pushes the rest of the
    // page down for everyone who already does.
    const wrapper = await mountSettings()
    useAdvancedModeStore().setEnabled(true)
    await flushPromises()

    expect(wrapper.text()).not.toContain(wrapper.vm.$t('settings.lastfmStep2'))
    const tips = wrapper
      .findAllComponents({ name: 'QualityTips' })
      .find((c) => (c.props('lines') as string[]).includes(wrapper.vm.$t('settings.lastfmStep2')))
    expect(tips).toBeDefined()
    // All four, in the order the registration form asks for them - the
    // callback note included, since that is the field nobody knows what
    // to do with.
    expect(tips!.props('lines')).toEqual([
      wrapper.vm.$t('settings.lastfmStep1'),
      wrapper.vm.$t('settings.lastfmStep2'),
      wrapper.vm.$t('settings.lastfmStep3'),
      wrapper.vm.$t('settings.lastfmStep4'),
    ])
  })

  it('links straight to where a key is requested', async () => {
    const wrapper = await mountSettings()
    useAdvancedModeStore().setEnabled(true)
    await flushPromises()

    const link = wrapper
      .findAll('a')
      .find((a) => a.text().includes(wrapper.vm.$t('settings.lastfmKeyGet')))
    expect(link?.attributes('href')).toBe('https://www.last.fm/api/account/create')
    // Opening an external page must not be able to reach back into the app.
    expect(link?.attributes('rel')).toContain('noopener')
  })

  it('shows at a glance whether a key is set', async () => {
    vi.mocked(getLastfmStatus).mockResolvedValue({ configured: true, fromEnvironment: false })
    const wrapper = await mountSettings()
    useAdvancedModeStore().setEnabled(true)
    await flushPromises()

    expect(wrapper.find('.status-dot--ok').exists()).toBe(true)
    expect(wrapper.find('.status-dot--warn').exists()).toBe(false)
  })

  it('marks an installation without a key as needing attention', async () => {
    const wrapper = await mountSettings()
    useAdvancedModeStore().setEnabled(true)
    await flushPromises()

    expect(wrapper.find('.status-dot--warn').exists()).toBe(true)
  })

  it('keeps working when the status check fails', async () => {
    vi.mocked(getLastfmStatus).mockRejectedValue(new Error('offline'))
    const wrapper = await mountSettings()

    expect(advancedToggle(wrapper).exists()).toBe(true)
  })
})
