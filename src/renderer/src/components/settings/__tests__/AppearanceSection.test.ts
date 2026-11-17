import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { MAX_CUSTOM_THEMES } from '@/plugins/theme'
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

    useAppearanceStore().addCustomTheme('Mine')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.custom-colors').exists()).toBe(true)
  })

  it('warns about an accent that does not stand out from its background', async () => {
    const store = useAppearanceStore()
    store.addCustomTheme('Mine')
    store.setCustomColors({ background: '#202020', primary: '#303030' })
    const wrapper = mountSection()
    expect(wrapper.find('.custom-colors__warning').exists()).toBe(true)

    store.setCustomColors({ primary: '#F5A94E' })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.custom-colors__warning').exists()).toBe(false)
  })

  it('keeps an opaque colour out of what the picker hands back', () => {
    useAppearanceStore().addCustomTheme('Mine')
    const wrapper = mountSection()
    ;(wrapper.vm as unknown as { setColor: (key: string, value: string) => void }).setColor(
      'primary',
      '#11223380',
    )
    expect(useAppearanceStore().selectedCustomTheme!.primary).toBe('#112233')
  })

  it('makes a new theme with the add button', async () => {
    const wrapper = mountSection()
    await wrapper.find('.custom-themes__add').trigger('click')
    expect(useAppearanceStore().customThemes).toHaveLength(1)
    expect(useAppearanceStore().selectedCustomTheme).not.toBeNull()
  })

  it('stops offering a new theme at the limit', () => {
    const store = useAppearanceStore()
    for (let i = 0; i < MAX_CUSTOM_THEMES; i++) store.addCustomTheme(`T${i}`)
    const wrapper = mountSection()
    expect(wrapper.find('.custom-themes__add').attributes('disabled')).toBeDefined()
  })

  it('lists every self-made theme in the menu', () => {
    const store = useAppearanceStore()
    store.addCustomTheme('One')
    store.addCustomTheme('Two')
    const items = mountSection().findComponent({ name: 'VSelect' }).props('items') as {
      title?: string
    }[]
    expect(items.map((item) => item.title)).toEqual(expect.arrayContaining(['One', 'Two']))
  })

  it('gives an unnamed theme a name in the menu', () => {
    const store = useAppearanceStore()
    store.addCustomTheme('')
    const items = mountSection().findComponent({ name: 'VSelect' }).props('items') as {
      value?: string
      title?: string
    }[]
    expect(items.find((item) => item.value === store.theme)!.title).toBeTruthy()
  })
})
