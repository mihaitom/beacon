// Where the sections sit relative to each other. The controls themselves
// are tested where they live (components/settings/__tests__/); what this
// page owns is the order and the gating — which section a toggle ends up
// in, and which one disappears for an account that may not see it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import SettingsView from '../SettingsView.vue'

const vuetify = createVuetify({ components, directives })

/** The recommendations toggle lives in the Library section, because its
 * seed artists come out of the library. That section also carries the
 * scan/refresh control, which not every account has — a non-admin
 * Navidrome account gets neither (capabilitiesFor()'s isAdmin) — so the
 * section as a whole must not be gated on those, or the toggle silently
 * disappears along with them. */
describe('SettingsView recommendations toggle placement', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // isAdmin, not capabilities: the latter is a getter derived from this
  // and serverType (capabilitiesFor()), so driving it from the real input
  // is what actually exercises the non-admin case.
  function mountWith(isAdmin: boolean, serverType: 'subsonic' | 'jellyfin') {
    const auth = useAuthStore()
    auth.isAdmin = isAdmin
    auth.serverType = serverType
    return mount(SettingsView, {
      global: {
        plugins: [vuetify, i18n],
        mocks: { $emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
        stubs: { ConnectButton: true, RemoteControlButton: true },
      },
    })
  }

  const label = () => i18n.global.t('settings.recommendations')

  it('shows it to an account that can trigger a library scan', () => {
    expect(mountWith(true, 'subsonic').text()).toContain(label())
  })

  it('still shows it to an account that cannot scan or refresh anything', () => {
    const wrapper = mountWith(false, 'subsonic')

    // The scan button is gone for this account …
    expect(wrapper.text()).not.toContain(i18n.global.t('settings.rescanLibrary'))
    // … but the toggle, which has nothing to do with scanning, is not.
    expect(wrapper.text()).toContain(label())
  })

  it('keeps it out of the advanced section, which is the log level alone', () => {
    const wrapper = mountWith(true, 'subsonic')
    const sections = wrapper.findAll('section')
    const advanced = sections.find((s) =>
      s.text().includes(i18n.global.t('settings.advancedTitle')),
    )
    const library = sections.find((s) => s.text().includes(i18n.global.t('settings.libraryTitle')))

    expect(advanced?.text()).not.toContain(label())
    expect(library?.text()).toContain(label())
  })
})

/** The Advanced section is the log-level dropdown and nothing else — for a
 * non-admin account (capabilities.logLevelControl) it has to disappear
 * entirely, not just lose its control, or they'd see an empty "Advanced"
 * heading. */
describe('SettingsView log level gating', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function mountWith(isAdmin: boolean) {
    const auth = useAuthStore()
    auth.isAdmin = isAdmin
    auth.serverType = 'subsonic'
    return mount(SettingsView, {
      global: {
        plugins: [vuetify, i18n],
        mocks: { $emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
        stubs: { ConnectButton: true, RemoteControlButton: true },
      },
    })
  }

  it('shows the log level control to an admin', () => {
    const wrapper = mountWith(true)

    expect(wrapper.text()).toContain(i18n.global.t('settings.logLevel'))
  })

  it('hides the log level control from a non-admin', () => {
    // Only the control, not the section around it: the section also holds
    // the advanced-features switch, which everyone has to be able to find
    // (see stores/advancedMode.ts). It used to be gated as a whole,
    // because the log level was the only thing in it.
    const wrapper = mountWith(false)

    expect(wrapper.text()).not.toContain(i18n.global.t('settings.logLevel'))
    expect(wrapper.text()).toContain(i18n.global.t('settings.advancedTitle'))
  })
})
