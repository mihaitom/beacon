// The guest's Milkdrop menu: the shipped presets, a click shows one, and
// nothing of the host's (uploads, the pool). Not the copy or the layout.
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { nowPlayingSourceKey } from '@/components/now-playing/source'
import { BUILTIN_PRESETS } from '@/services/milkdrop/presets'
import GuestMilkdropButton from '../components/GuestMilkdropButton.vue'

async function openMenu(current: string | null = null) {
  const choose = vi.fn()
  const wrapper = mount(GuestMilkdropButton, {
    props: { current },
    global: {
      plugins: [createVuetify({ components, directives }), i18n],
      stubs: { 'v-dialog': { template: '<div><slot /></div>' } },
      provide: { [nowPlayingSourceKey as symbol]: { chooseMilkdropPreset: choose } },
    },
  })
  await wrapper.find('button').trigger('click')
  await flushPromises()
  return { wrapper, choose }
}

describe('GuestMilkdropButton', () => {
  it('shows the shipped presets, and a click shows that one', async () => {
    const { wrapper, choose } = await openMenu()
    const rows = wrapper.findAll('.milkdrop-picker__row')
    expect(rows).toHaveLength(BUILTIN_PRESETS.length)
    const second = BUILTIN_PRESETS[1]!
    await rows.find((row) => row.text().includes(second.name))!.trigger('click')
    expect(choose).toHaveBeenCalledWith(second.key)
  })

  it('has no pool to tick and nothing to delete', async () => {
    const { wrapper } = await openMenu()
    expect(wrapper.findComponent({ name: 'VCheckboxBtn' }).exists()).toBe(false)
    const deleteLabel = i18n.global.t('milkdrop.delete')
    expect(wrapper.find(`[aria-label="${deleteLabel}"]`).exists()).toBe(false)
  })
})
