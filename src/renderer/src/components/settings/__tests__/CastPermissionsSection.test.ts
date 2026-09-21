// The Casting section: shown only in the web/Docker build and only for a
// server admin, it lets the admin keep the cast policy — one "who may cast"
// choice plus the account list (see docs/cast-permissions.md). These tests
// cover the gating, the four-state mapping and the save payload — not the
// copy or the element count.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { getCastPermissions, setCastPermissions } from '@/services/connect/castPermissions'
import CastPermissionsSection from '../CastPermissionsSection.vue'

vi.mock('@/services/connect/castPermissions', () => ({
  getCastPermissions: vi.fn(),
  setCastPermissions: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })

const emit = vi.fn()

function mountSection() {
  return mount(CastPermissionsSection, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit, on: vi.fn(), off: vi.fn() } },
    },
  })
}

function makeAdmin(): void {
  const auth = useAuthStore()
  auth.serverType = 'subsonic'
  auth.isAdmin = true
}

type SectionVm = {
  accounts: string[]
  policy: string
  suggestedAccounts: string[]
  listApplies: boolean
  effectHint: string
  save: () => Promise<void>
}

describe('CastPermissionsSection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getCastPermissions).mockResolvedValue({
      accounts: [],
      mode: 'allowlist',
      default_allow: true,
      suggested_accounts: ['alice', 'bob'],
      lists_users: true,
    })
    vi.mocked(setCastPermissions).mockResolvedValue({
      accounts: [],
      mode: 'allowlist',
      default_allow: true,
    })
    emit.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is hidden for a non-admin', async () => {
    const auth = useAuthStore()
    auth.serverType = 'subsonic'
    auth.isAdmin = false

    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('.settings-section').exists()).toBe(false)
  })

  it('is hidden while the admin flag is unknown', async () => {
    // A null admin flag must not offer a section whose save would 403.
    const auth = useAuthStore()
    auth.serverType = 'subsonic'
    auth.isAdmin = null

    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('.settings-section').exists()).toBe(false)
  })

  it('is hidden in the Electron build', async () => {
    makeAdmin()
    window.api = {} as typeof window.api
    try {
      const wrapper = mountSection()
      await flushPromises()

      expect(wrapper.find('.settings-section').exists()).toBe(false)
    } finally {
      window.api = undefined as unknown as typeof window.api
    }
  })

  it.each([
    ['allowlist', false, 'allowlist'],
    ['allowlist', true, 'everyone'],
    ['blocklist', true, 'blocklist'],
    ['blocklist', false, 'nobody'],
  ])('maps stored mode=%s default_allow=%s to the %s choice', async (mode, allow, policy) => {
    makeAdmin()
    vi.mocked(getCastPermissions).mockResolvedValue({
      accounts: ['alice'],
      mode: mode as 'allowlist' | 'blocklist',
      default_allow: allow,
      suggested_accounts: ['alice', 'bob'],
      lists_users: true,
    })

    const wrapper = mountSection()
    await flushPromises()

    const vm = wrapper.vm as unknown as SectionVm
    expect(vm.policy).toBe(policy)
    expect(vm.suggestedAccounts).toEqual(['alice', 'bob'])
  })

  it('only shows the account list for the choices where it matters', async () => {
    makeAdmin()
    const wrapper = mountSection()
    await flushPromises()
    const vm = wrapper.vm as unknown as SectionVm

    vm.policy = 'everyone'
    expect(vm.listApplies).toBe(false)

    vm.policy = 'allowlist'
    expect(vm.listApplies).toBe(true)

    vm.policy = 'nobody'
    expect(vm.listApplies).toBe(false)

    vm.policy = 'blocklist'
    expect(vm.listApplies).toBe(true)
  })

  it('spells out the rule each choice adds up to', async () => {
    makeAdmin()
    const wrapper = mountSection()
    await flushPromises()
    const vm = wrapper.vm as unknown as SectionVm

    vm.policy = 'everyone'
    expect(vm.effectHint).toBe(i18n.global.t('settings.castPermissionsEffectEveryone'))

    vm.policy = 'allowlist'
    vm.accounts = []
    expect(vm.effectHint).toBe(i18n.global.t('settings.castPermissionsEffectNobody'))

    vm.accounts = ['alice']
    expect(vm.effectHint).toBe(i18n.global.t('settings.castPermissionsEffectOnlyListed'))

    vm.policy = 'blocklist'
    expect(vm.effectHint).toBe(i18n.global.t('settings.castPermissionsEffectAllExceptListed'))
  })

  it('says the account list is incomplete when the server cannot offer one', async () => {
    makeAdmin()
    vi.mocked(getCastPermissions).mockResolvedValue({
      accounts: [],
      mode: 'allowlist',
      default_allow: false,
      suggested_accounts: ['alice'],
      lists_users: false,
    })

    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.text()).toContain(i18n.global.t('settings.castPermissionsNoUsers'))
  })

  it('saves the chosen policy as mode plus unlisted default', async () => {
    makeAdmin()
    vi.mocked(setCastPermissions).mockResolvedValue({
      accounts: ['carol'],
      mode: 'allowlist',
      default_allow: false,
    })

    const wrapper = mountSection()
    await flushPromises()
    const vm = wrapper.vm as unknown as SectionVm
    vm.accounts = ['carol']
    vm.policy = 'allowlist'
    await vm.save()

    expect(setCastPermissions).toHaveBeenCalledWith({
      accounts: ['carol'],
      mode: 'allowlist',
      default_allow: false,
    })
    expect(vm.accounts).toEqual(['carol'])
    expect(emit).toHaveBeenCalledWith('toast', expect.objectContaining({ level: 'success' }))
  })

  it('saves a blocklist choice as a blocklist with unlisted allowed', async () => {
    makeAdmin()
    vi.mocked(setCastPermissions).mockResolvedValue({
      accounts: ['guest'],
      mode: 'blocklist',
      default_allow: true,
    })

    const wrapper = mountSection()
    await flushPromises()
    const vm = wrapper.vm as unknown as SectionVm
    vm.accounts = ['guest']
    vm.policy = 'blocklist'
    await vm.save()

    expect(setCastPermissions).toHaveBeenCalledWith({
      accounts: ['guest'],
      mode: 'blocklist',
      default_allow: true,
    })
  })

  it('reports a failed save instead of pretending it worked', async () => {
    makeAdmin()
    vi.mocked(setCastPermissions).mockRejectedValue(new Error('nope'))

    const wrapper = mountSection()
    await flushPromises()
    const vm = wrapper.vm as unknown as SectionVm
    await vm.save()

    expect(emit).toHaveBeenCalledWith('toast', expect.objectContaining({ level: 'error' }))
  })
})
