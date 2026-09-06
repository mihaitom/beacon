import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
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
    // The scan belongs to the library store now - it outlives this page,
    // see its own startScan().
    Object.assign(useLibraryStore(), state)
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

/** The scan button changed size three times per scan: it shrank on the
 * first click, grew again with every digit the count gained, and snapped
 * back to full width at the end. Vuetify hides a loading button's content
 * but keeps it in the layout, so the progress label was invisible *and*
 * still sizing the button. */
describe('SettingsView scan button', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function mountSettings() {
    return mount(SettingsView, {
      global: {
        plugins: [vuetify, i18n],
        mocks: { $emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
        stubs: { ConnectButton: true, RemoteControlButton: true },
      },
    })
  }

  function scanButton(wrapper: ReturnType<typeof mountSettings>) {
    return wrapper
      .findAll('button')
      .find((button) => button.text().includes(i18n.global.t('settings.rescanLibrary')))
  }

  it('keeps its own label while the scan runs', async () => {
    const wrapper = mountSettings()
    useAuthStore().serverType = 'subsonic'
    await wrapper.vm.$nextTick()
    expect(scanButton(wrapper)).toBeDefined()

    Object.assign(useLibraryStore(), { scanning: true, scanCount: 1234, scanPercent: null })
    await wrapper.vm.$nextTick()

    // Same button, same words - the only thing that changed is the spinner
    // Vuetify draws over them.
    const button = scanButton(wrapper)
    expect(button).toBeDefined()
    expect(button!.text()).not.toContain('1234')
  })

  it('puts the progress where it can actually be read', async () => {
    const wrapper = mountSettings()
    useAuthStore().serverType = 'subsonic'
    Object.assign(useLibraryStore(), { scanning: true, scanCount: 1234, scanPercent: null })
    await wrapper.vm.$nextTick()

    const progress = wrapper.findAll('.setting__status').find((p) => p.text().includes('1234'))
    expect(progress).toBeDefined()
    // Outside the button, not inside it where nothing is visible.
    expect(progress!.element.closest('button')).toBeNull()
  })

  /** Jellyfin and Plex report a percentage, so the ring in the button can
   * fill rather than just turn. */
  it('fills its spinner where the server reports a percentage', async () => {
    const wrapper = mountSettings()
    useAuthStore().serverType = 'plex'
    Object.assign(useLibraryStore(), { scanning: true, scanCount: null, scanPercent: 34 })
    await wrapper.vm.$nextTick()

    const ring = wrapper.find('.v-btn__loader .v-progress-circular')
    expect(ring.exists()).toBe(true)
    expect(ring.classes()).not.toContain('v-progress-circular--indeterminate')
    expect(ring.attributes('aria-valuenow')).toBe('34')
  })

  /** Navidrome counts items and has no total to divide by, so there is
   * nothing to fill and the ring keeps turning. */
  it('keeps the spinner turning where the server only counts', async () => {
    const wrapper = mountSettings()
    useAuthStore().serverType = 'subsonic'
    Object.assign(useLibraryStore(), { scanning: true, scanCount: 1234, scanPercent: null })
    await wrapper.vm.$nextTick()

    const ring = wrapper.find('.v-btn__loader .v-progress-circular')
    expect(ring.exists()).toBe(true)
    expect(ring.classes()).toContain('v-progress-circular--indeterminate')
  })

  /** Every server type shows this button - it is gated on being an admin,
   * not on which server it is - and the line above it used to promise a
   * Plex or Jellyfin admin that Navidrome would do the scanning. */
  it('names the server the scan will actually run on', async () => {
    const wrapper = mountSettings()
    useAuthStore().serverType = 'plex'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain(i18n.global.t('auth.serverTypePlex'))
    expect(wrapper.text()).not.toContain(
      i18n.global.t('settings.libraryScanHint', {
        server: i18n.global.t('auth.serverTypeSubsonic'),
      }),
    )
  })

  it('says nothing about progress when no scan is running', async () => {
    const wrapper = mountSettings()
    useAuthStore().serverType = 'subsonic'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain(i18n.global.t('settings.scanningPlain'))
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

/** The Advanced section is the log-level dropdown and nothing else — for a
 * non-admin account (capabilities.logLevelControl) it has to disappear
 * entirely, not just lose its control, or they'd see an empty "Advanced"
 * heading. */
describe('SettingsView advanced section gating', () => {
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

  it('shows the advanced section to an admin', () => {
    const wrapper = mountWith(true)

    expect(wrapper.text()).toContain(i18n.global.t('settings.advancedTitle'))
  })

  it('hides the advanced section entirely from a non-admin', () => {
    const wrapper = mountWith(false)

    expect(wrapper.text()).not.toContain(i18n.global.t('settings.advancedTitle'))
  })
})
