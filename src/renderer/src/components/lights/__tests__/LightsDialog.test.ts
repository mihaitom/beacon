// The lights dialog: it loads afresh when opened, pairs, says which way a
// pairing failed, and saves each choice. Not the copy or the layout.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { ConnectApiError } from '@/services/connect/http'
import {
  discoverBridges,
  forgetBridge,
  getLights,
  pairBridge,
  updateLights,
  type LightsState,
} from '@/services/connect/lights'
import LightsDialog from '../LightsDialog.vue'
import LightsButton from '../LightsButton.vue'

vi.mock('@/services/connect/lights', () => ({
  getLights: vi.fn(),
  discoverBridges: vi.fn(),
  pairBridge: vi.fn(),
  updateLights: vi.fn(),
  forgetBridge: vi.fn(),
  reportLocalPlayback: vi.fn(),
  stopLocalReport: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })
const emit = vi.fn()

const UNPAIRED: LightsState = {
  paired: false,
  found: [{ host: '10.0.0.2', id: 'abc' }],
  bridge: null,
  reachable: null,
  areas: null,
  area_id: null,
  enabled: false,
  lead_ms: 80,
  style: 'pulse',
  colour_mode: 'cover',
  fixed_colour: '#3b6bff',
  brightness: 100,
  picture_colours: null,
  playing: false,
  start_error: null,
}

const PAIRED: LightsState = {
  ...UNPAIRED,
  paired: true,
  found: [],
  bridge: { host: '10.0.0.2', id: 'abc' },
  reachable: true,
  areas: [
    { id: 'area-1', name: 'Office', lights: 2 },
    { id: 'area-2', name: 'Living room', lights: 5 },
  ],
  area_id: 'area-1',
  picture_colours: ['#ff0000', '#0000ff', '#00ff00'],
}

type Vm = {
  host: string
  state: LightsState | null
  brightness: number
  leadInput: string | number
  leadInvalid: boolean
  pair: () => Promise<void>
  search: () => Promise<void>
  save: (u: object) => Promise<void>
  saveLead: () => Promise<void>
  forget: () => Promise<void>
}

const global = {
  plugins: [vuetify, i18n],
  mocks: { $emitter: { emit, on: vi.fn(), off: vi.fn() } },
  stubs: { 'v-dialog': { template: '<div><slot /></div>' }, 'lights-stage': true },
}

async function openDialog(state: LightsState) {
  vi.mocked(getLights).mockResolvedValue(state)
  const wrapper = mount(LightsDialog, { props: { modelValue: true }, global })
  await flushPromises()
  return wrapper.vm as unknown as Vm
}

async function openDialogWrapper(state: LightsState) {
  vi.mocked(getLights).mockResolvedValue(state)
  vi.mocked(updateLights).mockImplementation(async (update) => ({ ...state, ...update }))
  const wrapper = mount(LightsDialog, { props: { modelValue: true }, global })
  await flushPromises()
  return wrapper
}

function lastToast() {
  return emit.mock.calls.filter(([name]) => name === 'toast').at(-1)?.[1]
}

describe('LightsDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('loads when opened, not before', async () => {
    vi.mocked(getLights).mockResolvedValue(UNPAIRED)
    const wrapper = mount(LightsDialog, { props: { modelValue: false }, global })
    await flushPromises()
    expect(getLights).not.toHaveBeenCalled()
    await wrapper.setProps({ modelValue: true })
    await flushPromises()
    expect(getLights).toHaveBeenCalledTimes(1)
  })

  it('offers the bridge connect found and pairs with it', async () => {
    vi.mocked(pairBridge).mockResolvedValue(PAIRED)
    const vm = await openDialog(UNPAIRED)
    expect(vm.host).toBe('10.0.0.2')
    await vm.pair()
    expect(pairBridge).toHaveBeenCalledWith('10.0.0.2')
    expect(vm.state?.paired).toBe(true)
  })

  it('a search adds what it finds', async () => {
    vi.mocked(discoverBridges).mockResolvedValue([{ host: '10.0.0.7', id: 'x' }])
    const vm = await openDialog({ ...UNPAIRED, found: [] })
    await vm.search()
    expect(vm.host).toBe('10.0.0.7')
  })

  it('says so when nobody pressed the button', async () => {
    vi.mocked(pairBridge).mockRejectedValue(
      new ConnectApiError('timeout', { detail: 'link_button' }),
    )
    const vm = await openDialog(UNPAIRED)
    await vm.pair()
    expect(lastToast().level).toBe('error')
    expect(lastToast().message).toBe(i18n.global.t('lights.buttonTimeout'))
    expect(vm.state?.paired).toBe(false)
  })

  it('tells a wrong address apart from a failed pairing', async () => {
    vi.mocked(pairBridge).mockRejectedValue(new ConnectApiError('404', { detail: 'no_bridge' }))
    const vm = await openDialog(UNPAIRED)
    vm.host = '10.0.0.9'
    await vm.pair()
    expect(lastToast().message).toContain('10.0.0.9')
  })

  it('picks an area, a style and a colour source by clicking them', async () => {
    const wrapper = await openDialogWrapper(PAIRED)
    const area = wrapper.findAll('[role="radio"]').find((b) => b.text().includes('Living room'))!
    await area.trigger('click')
    await flushPromises()
    expect(updateLights).toHaveBeenLastCalledWith({ area_id: 'area-2' })
    const party = wrapper
      .findAll('[role="radio"]')
      .find((b) => b.text() === i18n.global.t('lights.styles.party.name'))!
    await party.trigger('click')
    await flushPromises()
    expect(updateLights).toHaveBeenLastCalledWith({ style: 'party' })
    const fixed = wrapper
      .findAll('[role="radio"]')
      .find((b) => b.text() === i18n.global.t('lights.colourModes.fixed'))!
    await fixed.trigger('click')
    expect(updateLights).toHaveBeenLastCalledWith({ colour_mode: 'fixed' })
  })

  it('a fixed colour comes from a swatch or the colour picker', async () => {
    const wrapper = await openDialogWrapper({ ...PAIRED, colour_mode: 'fixed' })
    await wrapper.find('button[aria-label="#ff3b5c"]').trigger('click')
    expect(updateLights).toHaveBeenLastCalledWith({ fixed_colour: '#ff3b5c' })
    await flushPromises() // the picker waits for that save
    const picker = wrapper.find('input[type="color"]')
    ;(picker.element as HTMLInputElement).value = '#123456'
    await picker.trigger('change')
    expect(updateLights).toHaveBeenLastCalledWith({ fixed_colour: '#123456' })
  })

  it("shows the cover's colours: one, or all of them as a palette", async () => {
    const swatches = (w: Awaited<ReturnType<typeof openDialogWrapper>>) =>
      w.findAll('.lights__swatch--static').length
    expect(swatches(await openDialogWrapper(PAIRED))).toBe(1)
    expect(swatches(await openDialogWrapper({ ...PAIRED, colour_mode: 'palette' }))).toBe(3)
  })

  it('the rotation shows a colour for every light of the area', async () => {
    const wrapper = await openDialogWrapper({ ...PAIRED, colour_mode: 'rotate', area_id: 'area-2' })
    expect(wrapper.findAll('.lights__swatch--static')).toHaveLength(5)
  })

  it('saves the brightness once it settles, also when set with the keyboard', async () => {
    const wrapper = await openDialogWrapper({ ...PAIRED, brightness: 70 })
    vi.useFakeTimers()
    try {
      const thumb = wrapper.find('.v-slider-thumb')
      await thumb.trigger('keydown', { key: 'ArrowRight' })
      await thumb.trigger('keydown', { key: 'ArrowRight' })
      expect(updateLights).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(updateLights).toHaveBeenCalledTimes(1)
      expect(updateLights).toHaveBeenCalledWith({ brightness: 80 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed brightness save goes back to what connect has', async () => {
    vi.mocked(updateLights).mockRejectedValue(new Error('down'))
    const vm = await openDialog({ ...PAIRED, brightness: 70 })
    vm.brightness = 30
    await vm.save({ brightness: 30 })
    expect(vm.brightness).toBe(70)
  })

  it('saves a choice and shows what connect stored', async () => {
    vi.mocked(updateLights).mockResolvedValue({ ...PAIRED, enabled: true })
    const vm = await openDialog(PAIRED)
    await vm.save({ enabled: true })
    expect(updateLights).toHaveBeenCalledWith({ enabled: true })
    expect(vm.state?.enabled).toBe(true)
  })

  it('saves the lead only when it is a valid change', async () => {
    vi.mocked(updateLights).mockResolvedValue({ ...PAIRED, lead_ms: 150 })
    const vm = await openDialog(PAIRED)
    await vm.saveLead()
    expect(updateLights).not.toHaveBeenCalled()
    vm.leadInput = '5000'
    expect(vm.leadInvalid).toBe(true)
    await vm.saveLead()
    expect(updateLights).not.toHaveBeenCalled()
    vm.leadInput = '150'
    await vm.saveLead()
    expect(updateLights).toHaveBeenCalledWith({ lead_ms: 150 })
  })

  it('a failed save says so', async () => {
    vi.mocked(updateLights).mockRejectedValue(new Error('down'))
    const vm = await openDialog(PAIRED)
    await vm.save({ enabled: true })
    expect(lastToast().level).toBe('error')
  })

  it('forgets the bridge and goes back to pairing', async () => {
    vi.mocked(forgetBridge).mockResolvedValue()
    const vm = await openDialog(PAIRED)
    vi.mocked(getLights).mockResolvedValue(UNPAIRED)
    await vm.forget()
    expect(forgetBridge).toHaveBeenCalled()
    expect(vm.state?.paired).toBe(false)
  })
})

describe('LightsButton', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('loads after login and appears once connect finds a bridge', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(getLights).mockRejectedValueOnce(new Error('connect not up yet'))
      vi.mocked(getLights).mockResolvedValueOnce({ ...UNPAIRED, found: [] })
      vi.mocked(getLights).mockResolvedValue(UNPAIRED)
      const { useAuthStore } = await import('@/stores/auth')
      const wrapper = mount(LightsButton, { global })
      await flushPromises()
      expect(getLights).not.toHaveBeenCalled()
      useAuthStore().authenticated = true
      await flushPromises()
      expect(wrapper.find('button').exists()).toBe(false)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(getLights).toHaveBeenCalledTimes(2)
      expect(wrapper.find('button').exists()).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(wrapper.find('button').exists()).toBe(true)
      // Switched on from another device: this app learns it within a minute.
      vi.mocked(getLights).mockResolvedValue({ ...UNPAIRED, ...PAIRED, enabled: true })
      const { useLightsStore } = await import('@/stores/lights')
      expect(useLightsStore().active).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(useLightsStore().active).toBe(true)
      wrapper.unmount()
      const calls = vi.mocked(getLights).mock.calls.length
      await vi.advanceTimersByTimeAsync(120_000)
      expect(getLights).toHaveBeenCalledTimes(calls)
    } finally {
      vi.useRealTimers()
    }
  })
})
