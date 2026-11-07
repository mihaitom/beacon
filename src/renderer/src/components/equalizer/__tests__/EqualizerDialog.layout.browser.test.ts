// Real-browser test for the equalizer dialog on a phone - run via
// `pnpm test:layout`. Windowed, its three buttons did not fit one row at
// phone width; fullscreen with the close button in the title, two are left.
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@/assets/main.css'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { h } from 'vue'
import { i18n } from '@/i18n'
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import { makeSong, makeStatus } from '@/stores/__tests__/fixtures'
import EqualizerDialog from '../EqualizerDialog.vue'

const vuetify = createVuetify({ components, directives })
let wrapper: VueWrapper | null = null

describe('equalizer dialog on a phone', () => {
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    i18n.global.locale = 'en'
  })

  // Every language: the longest labels decide whether the row fits.
  it.each(['de', 'en', 'es', 'fr', 'it'])('keeps its buttons in one row (%s)', async (locale) => {
    await page.viewport(360, 740)
    i18n.global.locale = locale as typeof i18n.global.locale
    setActivePinia(createPinia())
    useConnectStore().status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)
    playback.isPlaying = true
    wrapper = mount(
      {
        render: () =>
          h(components.VApp, null, {
            default: () => h(EqualizerDialog, { modelValue: true, compact: true }),
          }),
      },
      // Real transitions: test-utils' stub would sit between the dialog and
      // its content and break Vuetify's child selectors, fullscreen included.
      {
        attachTo: document.body,
        global: { plugins: [vuetify, i18n], stubs: { transition: false } },
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 600))

    const buttons = Array.from(document.querySelectorAll('.v-card-actions .v-btn'))
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    const tops = new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top)))
    expect(tops.size).toBe(1)
    const actions = document.querySelector('.v-card-actions') as HTMLElement
    expect(actions.scrollWidth).toBeLessThanOrEqual(actions.clientWidth)
  })
})
