// The Library section's scan/refresh controls. Three servers, three
// different things they can say about a running scan: Navidrome counts
// processed items, the Jellyfin and Plex bridges report a percentage, and a
// server may report neither — the button has to stay meaningful in all
// three. It used to read "Scanning … (0)" for anything that had no count.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { useListenbrainzStore } from '@/stores/listenbrainz'
import { useFanartStore } from '@/stores/fanart'
import LibrarySection from '../LibrarySection.vue'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

const vuetify = createVuetify({ components, directives })

function mountSection() {
  return mount(LibrarySection, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
    },
  })
}

describe('LibrarySection scan progress label', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function scanLabelFor(state: { scanCount: number | null; scanPercent: number | null }): string {
    const wrapper = mountSection()
    // The scan belongs to the library store now - it outlives this
    // section, see its own startScan().
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
describe('LibrarySection scan button', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function scanButton(wrapper: ReturnType<typeof mountSection>) {
    return wrapper
      .findAll('button')
      .find((button) => button.text().includes(i18n.global.t('settings.rescanLibrary')))
  }

  it('keeps its own label while the scan runs', async () => {
    const wrapper = mountSection()
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
    const wrapper = mountSection()
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
    const wrapper = mountSection()
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
    const wrapper = mountSection()
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
    const wrapper = mountSection()
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
    const wrapper = mountSection()
    useAuthStore().serverType = 'subsonic'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain(i18n.global.t('settings.scanningPlain'))
  })
})

/** The ListenBrainz name entered here is what Home's personalized shelf
 * reads and what the playlist builder starts from, so it has to reach the
 * store — see stores/listenbrainz.ts. */
describe('LibrarySection ListenBrainz name', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  function nameField(wrapper: ReturnType<typeof mountSection>) {
    return wrapper.vm as unknown as {
      listenbrainzUsername: string
      saveListenbrainzUsername: () => void
    }
  }

  it('starts from what the store already holds', () => {
    useListenbrainzStore().setUsername('listener')
    const wrapper = mountSection()

    expect(nameField(wrapper).listenbrainzUsername).toBe('listener')
  })

  it('saves the name to the store', () => {
    const wrapper = mountSection()
    const field = nameField(wrapper)

    field.listenbrainzUsername = 'listener'
    field.saveListenbrainzUsername()

    expect(useListenbrainzStore().username).toBe('listener')
  })

  it('clears the name when the field is emptied', () => {
    useListenbrainzStore().setUsername('listener')
    const wrapper = mountSection()
    const field = nameField(wrapper)

    field.listenbrainzUsername = ''
    field.saveListenbrainzUsername()

    expect(useListenbrainzStore().username).toBe('')
  })
})

describe('LibrarySection artist images toggle', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('turns Fanart.tv artist images off and on', async () => {
    const wrapper = mountSection()
    const label = wrapper.vm.$t('settings.fanartEnabled')
    const toggle = wrapper
      .findAllComponents({ name: 'VSwitch' })
      .find((c) => c.props('label') === label)
    expect(toggle).toBeDefined()

    await toggle!.vm.$emit('update:modelValue', false)

    expect(useFanartStore().enabled).toBe(false)
  })
})
