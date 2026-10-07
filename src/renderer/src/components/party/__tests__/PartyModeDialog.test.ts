import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { usePartyStore } from '@/stores/party'
import PartyModeDialog from '../PartyModeDialog.vue'

// The dialog paints a real QR code once a party is running; jsdom has no
// canvas context, and what is under test here is the action row.
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn().mockResolvedValue(undefined) } }))

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

function mountDialog() {
  const wrapper = mount(PartyModeDialog, {
    props: { modelValue: false },
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: emitter },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

/** What the dialog asks its parent to do, if anything. */
function closeRequests(wrapper: VueWrapper) {
  return (wrapper.emitted('update:modelValue') ?? []).filter((event) => event[0] === false)
}

/** A button in the action row, found by the label the app gives it. */
function actionButton(label: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>('.v-card-actions button')].find(
    (button) => button.textContent?.trim() === label,
  )
}

describe('PartyModeDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.spyOn(usePartyStore(), 'refreshStatus').mockResolvedValue()
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
  })

  /** Starting a party is the primary action, but a dialog whose only way
   * out is clicking beside it is a dead end. */
  it('offers a way to close before a party is running', async () => {
    const wrapper = mountDialog()
    await wrapper.setProps({ modelValue: true })
    await wrapper.vm.$nextTick()

    actionButton(i18n.global.t('common.cancel'))!.click()
    await wrapper.vm.$nextTick()

    expect(closeRequests(wrapper)).toHaveLength(1)
  })

  it('offers Done once a party is running', async () => {
    const store = usePartyStore()
    store.enabled = true
    const wrapper = mountDialog()
    await wrapper.setProps({ modelValue: true })
    await wrapper.vm.$nextTick()

    actionButton(i18n.global.t('common.done'))!.click()
    await wrapper.vm.$nextTick()

    expect(closeRequests(wrapper)).toHaveLength(1)
  })
})
