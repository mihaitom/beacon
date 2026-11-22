// The Milkdrop menu: a name shows that preset, a tick puts it in the pool,
// an upload says what went in and what did not, and only uploaded presets
// can be deleted. Not the copy or the layout.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import {
  deleteMilkdropPreset,
  listMilkdropPresets,
  putMilkdropPreset,
} from '@/services/connect/milkdropPresets'
import { presetFromFile } from '@/services/milkdrop/convert'
import { BUILTIN_PRESETS } from '@/services/milkdrop/presets'
import { useMilkdropStore } from '@/stores/milkdrop'
import MilkdropDialog from '../MilkdropDialog.vue'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/services/connect/milkdropPresets', () => ({
  listMilkdropPresets: vi.fn(),
  putMilkdropPreset: vi.fn().mockResolvedValue(undefined),
  deleteMilkdropPreset: vi.fn().mockResolvedValue(undefined),
  getMilkdropPreset: vi.fn(),
}))
vi.mock('@/services/milkdrop/convert', () => ({ presetFromFile: vi.fn() }))

const global = {
  plugins: [createVuetify({ components, directives }), i18n],
  stubs: { 'v-dialog': { template: '<div><slot /></div>' } },
}

async function open(current: string | null = null) {
  const wrapper = mount(MilkdropDialog, { props: { modelValue: true, current }, global })
  await flushPromises()
  return wrapper
}

function row(wrapper: Awaited<ReturnType<typeof open>>, name: string) {
  return wrapper.findAll('.milkdrop-menu__row').find((r) => r.text().includes(name))!
}

describe('MilkdropDialog', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    setActivePinia(createPinia())
    vi.mocked(listMilkdropPresets).mockResolvedValue([{ id: 'p1', name: 'My upload' }])
  })

  it('shows a preset when its name is clicked', async () => {
    const wrapper = await open()
    const entry = BUILTIN_PRESETS[2]!
    await row(wrapper, entry.name).get('.milkdrop-menu__name').trigger('click')
    expect(useMilkdropStore().settings.preset).toBe(entry.key)
  })

  it('puts a ticked preset in the pool without switching to it', async () => {
    const wrapper = await open()
    await row(wrapper, 'My upload').get('input[type=checkbox]').setValue(true)
    await row(wrapper, 'My upload').get('.milkdrop-menu__tick').trigger('click')
    expect(useMilkdropStore().settings.preferred).toEqual(['custom:p1'])
    expect(useMilkdropStore().settings.preset).toBeNull()
  })

  it('picks out the preset on screen', async () => {
    const entry = BUILTIN_PRESETS[4]!
    const wrapper = await open(entry.key)
    const current = wrapper.findAll('.milkdrop-menu__row--current')
    expect(current).toHaveLength(1)
    expect(current[0]!.text()).toContain(entry.name)
  })

  it('narrows the list to what the search finds', async () => {
    const wrapper = await open()
    await wrapper.get('.milkdrop-menu__search input').setValue('my upl')
    expect(wrapper.findAll('.milkdrop-menu__name')).toHaveLength(1)
    await wrapper.get('.milkdrop-menu__search input').setValue('zzz-nothing')
    expect(wrapper.findAll('.milkdrop-menu__name')).toHaveLength(0)
  })

  it('offers deleting only what was uploaded', async () => {
    const wrapper = await open()
    expect(row(wrapper, BUILTIN_PRESETS[0]!.name).find('.mdi-delete-outline').exists()).toBe(false)
    await row(wrapper, 'My upload').get('.mdi-delete-outline').element.closest('button')!.click()
    await flushPromises()
    expect(vi.mocked(deleteMilkdropPreset)).toHaveBeenCalledWith('p1')
    expect(wrapper.text()).not.toContain('My upload')
  })

  it('marks the presets that are hard on the graphics card, and only those', async () => {
    const wrapper = await open()
    const heavy = BUILTIN_PRESETS.find((entry) => entry.demanding)!
    const light = BUILTIN_PRESETS.find((entry) => !entry.demanding)!
    const mark = (name: string) => row(wrapper, name).find('[role=img][aria-label]')
    expect(mark(heavy.name).exists()).toBe(true)
    expect(mark(light.name).exists()).toBe(false)
    expect(mark('My upload').exists()).toBe(false)
  })

  it('says which uploaded files could not be read', async () => {
    vi.mocked(presetFromFile).mockImplementation(async (name) => {
      if (name === 'bad.milk') throw new Error('nope')
      return { name: 'Good', preset: { baseVals: {} } }
    })
    const wrapper = await open()
    const input = wrapper.get('input[type=file]')
    Object.defineProperty(input.element, 'files', {
      value: [new File(['x'], 'good.milk'), new File(['x'], 'bad.milk')],
    })
    await input.trigger('change')
    await flushPromises()

    expect(vi.mocked(putMilkdropPreset)).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.milkdrop-menu__status').text()).toContain('bad.milk')
    expect(wrapper.text()).toContain('Good')
  })

  it('moves the timer one step per wheel notch, up for longer', async () => {
    useMilkdropStore().set({ switchMode: 'time', intervalSeconds: 60 })
    const wrapper = await open()
    const interval = wrapper.get('.milkdrop-menu__interval')
    await interval.trigger('wheel', { deltaY: -100 })
    await interval.trigger('wheel', { deltaY: -100 })
    expect(useMilkdropStore().settings.intervalSeconds).toBe(120)
    await interval.trigger('wheel', { deltaY: 100 })
    expect(useMilkdropStore().settings.intervalSeconds).toBe(90)
  })
})
