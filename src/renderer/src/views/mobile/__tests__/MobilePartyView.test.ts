// The party on the phone: a page of its own rather than the desktop's
// dialog, with the same settings and the same buttons to start and end it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { usePartyStore } from '@/stores/party'
import MobilePartyView from '../MobilePartyView.vue'

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn().mockResolvedValue(undefined) } }))

const vuetify = createVuetify({ components, directives })

function mountView() {
  return mount(MobilePartyView, {
    global: { plugins: [vuetify, i18n], mocks: { $emitter: emitter } },
  })
}

function button(wrapper: ReturnType<typeof mountView>, label: string) {
  return wrapper.findAll('button').find((b) => b.text().trim() === label)
}

describe('MobilePartyView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.spyOn(usePartyStore(), 'refreshStatus').mockResolvedValue()
  })

  /** Opened from another device since this one last looked, a running
   * party has to show as running. */
  it('asks whether a party is running when it opens', () => {
    mountView()

    expect(usePartyStore().refreshStatus).toHaveBeenCalled()
  })

  it('starts a party, with nothing to close', async () => {
    const enable = vi.spyOn(usePartyStore(), 'enable').mockResolvedValue()
    const wrapper = mountView()

    await button(wrapper, i18n.global.t('party.start'))!.trigger('click')
    await flushPromises()

    expect(enable).toHaveBeenCalledOnce()
    expect(button(wrapper, i18n.global.t('common.cancel'))).toBeUndefined()
  })

  it('ends a running party', async () => {
    const store = usePartyStore()
    store.enabled = true
    const disable = vi.spyOn(store, 'disable').mockResolvedValue()
    const wrapper = mountView()

    await button(wrapper, i18n.global.t('party.end'))!.trigger('click')
    await flushPromises()

    expect(disable).toHaveBeenCalledOnce()
    expect(button(wrapper, i18n.global.t('common.done'))).toBeUndefined()
  })
})
