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

/** Three servers, three different things they can say about a running
 * scan: Navidrome counts processed items, the Jellyfin and Plex bridges
 * report a percentage, and a server may report neither. The button has to
 * stay meaningful in all three cases — it used to read "Scanning … (0)"
 * for anything that had no count. */
describe('SettingsView scan progress label', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function scanLabelFor(state: { scanCount: number | null; scanPercent: number | null }): string {
    const wrapper = mount(SettingsView, {
      global: {
        plugins: [vuetify, i18n],
        mocks: { $emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
        stubs: { ConnectButton: true, RemoteControlButton: true },
      },
    })
    Object.assign(wrapper.vm, state)
    return (wrapper.vm as unknown as { scanLabel: string }).scanLabel
  }

  it('shows the item count where the server keeps one', () => {
    expect(scanLabelFor({ scanCount: 1234, scanPercent: null })).toContain('1234')
  })

  it('shows a percentage where that is all the server knows', () => {
    const label = scanLabelFor({ scanCount: null, scanPercent: 34 })

    expect(label).toContain('34')
    expect(label).toContain('%')
  })

  it('still says something is happening when the server offers no number', () => {
    const label = scanLabelFor({ scanCount: null, scanPercent: null })

    expect(label.length).toBeGreaterThan(0)
    // Not a stray "(0)" or an empty parenthesis left over from a template
    // expecting a value that never came.
    expect(label).not.toContain('0')
    expect(label).not.toContain('(')
  })
})

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
