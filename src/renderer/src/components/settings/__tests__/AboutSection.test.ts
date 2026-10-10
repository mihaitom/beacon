import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useUpdateStore } from '@/stores/update'
import AboutSection from '../AboutSection.vue'

const vuetify = createVuetify({ components, directives })

function mountSection() {
  return mount(AboutSection, {
    global: { plugins: [vuetify, i18n], stubs: { PrivacyDialog: true } },
  })
}

/** Settings opens on the tab with this section, so showing its update
 * notice is what puts the dot on the settings button out. */
describe('AboutSection and the settings dot', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('puts the dot out when it shows an update', () => {
    const update = useUpdateStore()
    update.available = true
    update.latestVersion = '2.0.0'

    mountSection()

    expect(update.unseen).toBe(false)
  })

  it('puts it out for an answer that only arrives while it is open', async () => {
    const update = useUpdateStore()
    const wrapper = mountSection()

    update.available = true
    update.latestVersion = '2.0.0'
    await wrapper.vm.$nextTick()

    expect(update.unseen).toBe(false)
  })
})
