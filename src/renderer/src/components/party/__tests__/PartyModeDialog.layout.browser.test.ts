// Real-browser layout test for the party dialog - run via `pnpm test:layout`.
// Whether a party of a normal size fits the dialog without scrolling is a
// question of computed heights, which jsdom does not have.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { defineComponent, h, ref } from 'vue'
import { VApp } from 'vuetify/components'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@/assets/main.css'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { beaconTheme } from '@/plugins/theme'
import PartyModeDialog from '../PartyModeDialog.vue'
import { usePartyStore } from '@/stores/party'

/** The dialog inside a v-app, as in the app: an overlay positions itself
 * against the application, not against the bare document. */
const open = ref(false)
const Host = defineComponent({
  render: () => h(VApp, null, { default: () => h(PartyModeDialog, { modelValue: open.value }) }),
})

const vuetify = createVuetify({ components, directives, theme: beaconTheme })
const wrappers: VueWrapper[] = []

function guests(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    guest_id: `g${i}`,
    name: `Guest ${i + 1}`,
    joined_at: 0,
    connected: i % 2 === 0,
  }))
}

async function openDialog(setup: (party: ReturnType<typeof usePartyStore>) => void) {
  const party = usePartyStore()
  vi.spyOn(party, 'refreshStatus').mockResolvedValue()
  setup(party)
  const wrapper = mount(Host, {
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: emitter },
    },
  })
  wrappers.push(wrapper)
  open.value = true
  await new Promise((resolve) => setTimeout(resolve, 400))
  return document.querySelector('.beacon-dialog > .v-card-text') as HTMLElement
}

describe('PartyModeDialog', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    open.value = false
    localStorage.clear()
    // Wider than any real window on purpose: under test the overlay places
    // the card's corner at the window's centre rather than centring it, so
    // only this much width leaves it the 900px it has in the app. The
    // height, which is what this is about, is the app's.
    await page.viewport(2000, 900)
  })

  afterEach(() => {
    wrappers.forEach((wrapper) => wrapper.unmount())
    wrappers.length = 0
  })

  it('fits a running party with a handful of guests without scrolling', async () => {
    const body = await openDialog((party) => {
      party.enabled = true
      party.hostedHere = true
      party.inviteToken = 'token'
      party.guests = guests(8)
    })
    expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight + 1)
  })
})
