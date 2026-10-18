import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAppearanceStore } from '@/stores/appearance'
import AppearanceSection from '../AppearanceSection.vue'

const vuetify = createVuetify({ components, directives })

function mountSection() {
  return mount(AppearanceSection, { global: { plugins: [vuetify, i18n] } })
}

describe('AppearanceSection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('switches the theme when one is picked', async () => {
    const wrapper = mountSection()
    await wrapper.findComponent({ name: 'VSelect' }).vm.$emit('update:modelValue', 'paper')
    expect(useAppearanceStore().theme).toBe('paper')
  })

  it('only offers the colours with the self-made theme picked', async () => {
    const wrapper = mountSection()
    expect(wrapper.find('.custom-colors').exists()).toBe(false)

    useAppearanceStore().setTheme('custom')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.custom-colors').exists()).toBe(true)
  })

  it('warns about an accent that does not stand out from its background', async () => {
    const store = useAppearanceStore()
    store.setTheme('custom')
    store.setCustomColors({ background: '#202020', primary: '#303030' })
    const wrapper = mountSection()
    expect(wrapper.find('.custom-colors__warning').exists()).toBe(true)

    store.setCustomColors({ primary: '#F5A94E' })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.custom-colors__warning').exists()).toBe(false)
  })

  it('keeps an opaque colour out of what the picker hands back', () => {
    useAppearanceStore().setTheme('custom')
    const wrapper = mountSection()
    ;(wrapper.vm as unknown as { setColor: (key: string, value: string) => void }).setColor(
      'primary',
      '#11223380',
    )
    expect(useAppearanceStore().custom.primary).toBe('#112233')
  })
})
