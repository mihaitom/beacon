import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
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
