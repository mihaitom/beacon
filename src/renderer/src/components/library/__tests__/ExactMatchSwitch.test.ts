import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import ExactMatchSwitch from '../ExactMatchSwitch.vue'
import { useLibraryStore } from '@/stores/library'

const vuetify = createVuetify({ components, directives })

describe('ExactMatchSwitch', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('turns the app-wide preference on and off again', async () => {
    const store = useLibraryStore()
    store.setSearchExact(false)
    const wrapper = mount(ExactMatchSwitch, {
      global: { plugins: [vuetify, i18n] },
    })
    const toggle = wrapper.find('button')

    await toggle.trigger('click')
    expect(store.searchExact).toBe(true)
    // The button carries no words, so its state has to reach a screen
    // reader some other way.
    expect(toggle.attributes('aria-pressed')).toBe('true')

    await toggle.trigger('click')
    expect(store.searchExact).toBe(false)
  })
})
