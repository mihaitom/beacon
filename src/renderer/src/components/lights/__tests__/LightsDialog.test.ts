// The lights dialog: it loads afresh when opened, pairs, says which way a
// pairing failed, and saves each choice. Not the copy or the layout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
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
  getPicture,
  getSongAnalysis,
  pairBridge,
  updateLights,
  type LightsState,
  type SongAnalysisReply,
} from '@/services/connect/lights'
import { MADE_UP_SONG } from '@/services/lights/stagePreview'
import type { Song } from '@/types/library'
import { DEFAULT_APP_ACCENT, themeAccent } from '@/services/appAccent'
import { useAppearanceStore } from '@/stores/appearance'
import { themeColour } from '@/stores/lights'
import { usePlaybackStore } from '@/stores/playback'
import LightsDialog from '../LightsDialog.vue'
import LightsButton from '../LightsButton.vue'

vi.mock('@/services/connect/lights', () => ({
  getLights: vi.fn(),
  getPicture: vi.fn(),
  getSongAnalysis: vi.fn(),
  discoverBridges: vi.fn(),
  pairBridge: vi.fn(),
  updateLights: vi.fn(),
  forgetBridge: vi.fn(),
  reportLocalPlayback: vi.fn(),
  stopLocalReport: vi.fn(),
}))

// A dialog left open keeps asking for the picture - in the next test's store.
enableAutoUnmount(afterEach)

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
  colour_mode: 'palette',
  fixed_colour: '#3b6bff',
  theme_colour: '#f5a94e',
  theme_follows_picture: true,
  brightness: 100,
  picture: null,
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
  picture: {
    source: 'cover',
    url: null,
    cover_art_id: 'al-1',
    colours: ['#ff0000', '#0000ff', '#00ff00'],
  },
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
  stubs: {
    'v-dialog': { template: '<div><slot /></div>' },
    'lights-stage': true,
    'lights-colour-wheel': true,
  },
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
    themeAccent.value = DEFAULT_APP_ACCENT
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

  it('a fixed colour comes from the hue band, saved once it settles', async () => {
    const wrapper = await openDialogWrapper({ ...PAIRED, colour_mode: 'fixed' })
    vi.useFakeTimers()
    try {
      // Dragged along, then let go on green.
      await wrapper.find('input[type="range"]').setValue('200')
      await wrapper.find('input[type="range"]').setValue('120')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(updateLights).toHaveBeenCalledTimes(1)
      expect(updateLights).toHaveBeenLastCalledWith({ fixed_colour: '#00ff00' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('the hue band starts on the stored colour and leaves it be when opened', async () => {
    const wrapper = await openDialogWrapper({
      ...PAIRED,
      colour_mode: 'fixed',
      fixed_colour: '#3b6bff',
    })
    vi.useFakeTimers()
    try {
      const band = wrapper.find('input[type="range"]').element as HTMLInputElement
      expect(Number(band.value)).toBe(225)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(updateLights).not.toHaveBeenCalledWith(
        expect.objectContaining({ fixed_colour: expect.anything() }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("the palette shows the picture's colours and where they come from", async () => {
    const wrapper = await openDialogWrapper(PAIRED)
    const shown = wrapper
      .findAll('.lights__detail .lights__swatch')
      .map((s) => s.attributes('style'))
    expect(shown.join()).toContain('rgb(255, 0, 0)')
    expect(shown.join()).toContain('rgb(0, 0, 255)')
    expect(wrapper.text()).toContain(i18n.global.t('lights.paletteFrom.cover'))
    expect(wrapper.find('.lights__thumb').exists()).toBe(true)
  })

  it('a black-and-white picture says the theme colour stands in', async () => {
    themeAccent.value = '0, 255, 0'
    const wrapper = await openDialogWrapper({
      ...PAIRED,
      theme_colour: '#00ff00',
      picture: {
        source: 'artist',
        url: 'https://assets.fanart.tv/x.jpg',
        cover_art_id: null,
        colours: [],
      },
    })
    expect(wrapper.text()).toContain(i18n.global.t('lights.paletteGrey'))
    expect(wrapper.find('.lights__detail .lights__swatch').attributes('style')).toContain(
      'rgb(0, 255, 0)',
    )
  })

  it('the rotation starts at the picture colour, or the theme colour without one', async () => {
    themeAccent.value = '0, 255, 0'
    const start = async (state: LightsState) =>
      (await openDialogWrapper({ ...state, colour_mode: 'rotate' }))
        .findComponent({ name: 'LightsColourWheel' })
        .props('start')
    expect(await start(PAIRED)).toEqual([255, 0, 0])
    expect(await start({ ...PAIRED, theme_colour: '#00ff00', picture: null })).toEqual([0, 255, 0])
  })

  it("choosing the theme takes this device's theme colour", async () => {
    const wrapper = await openDialogWrapper({ ...PAIRED, theme_colour: '#f5a94e' })
    themeAccent.value = '59, 107, 255'
    vi.mocked(updateLights).mockClear()
    const theme = wrapper
      .findAll('[role="radio"]')
      .find((b) => b.text() === i18n.global.t('lights.colourModes.theme'))!
    await theme.trigger('click')
    expect(updateLights).toHaveBeenLastCalledWith({
      colour_mode: 'theme',
      theme_colour: '#3b6bff',
      theme_follows_picture: true,
    })
  })

  it('opening the dialog reports this device theme colour where connect has another', async () => {
    themeAccent.value = '59, 107, 255'
    await openDialogWrapper({ ...PAIRED, theme_colour: '#f5a94e' })
    expect(updateLights).toHaveBeenCalledWith({
      theme_colour: '#3b6bff',
      theme_follows_picture: true,
    })
    vi.mocked(updateLights).mockClear()
    await openDialogWrapper({ ...PAIRED, theme_colour: '#3b6bff' })
    expect(updateLights).not.toHaveBeenCalled()
  })

  it('the theme takes the picture colour where the app accent follows the picture', async () => {
    const swatch = async (follows: boolean) =>
      (
        await openDialogWrapper({
          ...PAIRED,
          colour_mode: 'theme',
          theme_colour: themeColour(),
          theme_follows_picture: follows,
        })
      )
        .find('.lights__detail .lights__swatch')
        .attributes('style')
    useAppearanceStore().adaptiveAccent = true
    expect(await swatch(true)).toContain('rgb(255, 0, 0)')
    useAppearanceStore().adaptiveAccent = false
    expect(await swatch(false)).toContain('rgb(245, 169, 78)')
  })

  it('switching the picture-following accent off here carries over', async () => {
    useAppearanceStore().adaptiveAccent = false
    await openDialogWrapper({ ...PAIRED, theme_colour: themeColour() })
    expect(updateLights).toHaveBeenCalledWith({
      theme_colour: themeColour(),
      theme_follows_picture: false,
    })
  })

  it('follows the picture while open, so a track change shows the new one', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = await openDialogWrapper(PAIRED)
      const next = {
        source: 'cover' as const,
        url: null,
        cover_art_id: 'al-2',
        colours: ['#00ff00'],
      }
      vi.mocked(getPicture).mockResolvedValue(next)
      await vi.advanceTimersByTimeAsync(2_500)
      expect(wrapper.find('.lights__detail .lights__swatch').attributes('style')).toContain(
        'rgb(0, 255, 0)',
      )
      await wrapper.setProps({ modelValue: false })
      vi.mocked(getPicture).mockClear()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(getPicture).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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

describe('LightsDialog preview', () => {
  const READY: SongAnalysisReply = {
    status: 'ready',
    energy_rate: 4,
    energy: [0.5],
    beats: { times: [0.5, 1], downbeat: 0, period: 0.5 },
    hits: null,
    heard_from: 0.5,
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  function play(playing = true) {
    usePlaybackStore().$patch({
      queue: [{ id: 'song-1', title: 'A song' } as Song],
      currentIndex: 0,
      isPlaying: playing,
    })
  }

  function stageSong(wrapper: Awaited<ReturnType<typeof openDialogWrapper>>) {
    return wrapper.findComponent({ name: 'LightsStage' }).props('song')
  }

  it('plays along with the song that is playing', async () => {
    vi.mocked(getSongAnalysis).mockResolvedValue(READY)
    play()
    const wrapper = await openDialogWrapper(PAIRED)
    expect(getSongAnalysis).toHaveBeenCalledWith('song-1')
    expect(stageSong(wrapper)).not.toBe(MADE_UP_SONG)
    expect(stageSong(wrapper).beatAt(0.6)).toEqual([0, expect.closeTo(0.1)])
  })

  it('plays the made-up song while paused, and with nothing playing', async () => {
    vi.mocked(getSongAnalysis).mockResolvedValue(READY)
    play(false)
    const wrapper = await openDialogWrapper(PAIRED)
    expect(getSongAnalysis).not.toHaveBeenCalled()
    expect(stageSong(wrapper)).toBe(MADE_UP_SONG)
    usePlaybackStore().$patch({ isPlaying: true })
    await flushPromises()
    expect(stageSong(wrapper)).not.toBe(MADE_UP_SONG)
    usePlaybackStore().$patch({ isPlaying: false })
    await flushPromises()
    expect(stageSong(wrapper)).toBe(MADE_UP_SONG)
  })

  it('asks again while connect is still analysing, and stops once closed', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(getSongAnalysis).mockResolvedValue({ status: 'pending' })
      play()
      const wrapper = await openDialogWrapper(PAIRED)
      expect(stageSong(wrapper)).toBe(MADE_UP_SONG)
      vi.mocked(getSongAnalysis).mockResolvedValue(READY)
      await vi.advanceTimersByTimeAsync(1_500)
      expect(stageSong(wrapper)).not.toBe(MADE_UP_SONG)

      vi.mocked(getSongAnalysis).mockResolvedValue({ status: 'pending' })
      usePlaybackStore().$patch({ queue: [{ id: 'song-2', title: 'B' } as Song] })
      await flushPromises()
      expect(stageSong(wrapper)).toBe(MADE_UP_SONG)
      await wrapper.setProps({ modelValue: false })
      vi.mocked(getSongAnalysis).mockClear()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(getSongAnalysis).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a song that is no longer playing is not asked for again', async () => {
    vi.useFakeTimers()
    try {
      let answer!: (reply: SongAnalysisReply) => void
      vi.mocked(getSongAnalysis).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      vi.mocked(getSongAnalysis).mockResolvedValue(READY)
      play()
      await openDialogWrapper(PAIRED)
      usePlaybackStore().$patch({ queue: [{ id: 'song-2', title: 'B' } as Song] })
      await flushPromises()
      answer({ status: 'pending' })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(vi.mocked(getSongAnalysis).mock.calls.map(([id]) => id)).toEqual(['song-1', 'song-2'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('LightsButton', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('a theme change here carries over to the lights', async () => {
    themeAccent.value = DEFAULT_APP_ACCENT
    vi.mocked(getLights).mockResolvedValue({ ...PAIRED, theme_colour: '#f5a94e' })
    vi.mocked(updateLights).mockImplementation(async (update) => ({ ...PAIRED, ...update }))
    const { useAuthStore } = await import('@/stores/auth')
    useAuthStore().authenticated = true
    const wrapper = mount(LightsButton, { global })
    await flushPromises()
    expect(updateLights).not.toHaveBeenCalled()
    themeAccent.value = '59, 107, 255'
    await flushPromises()
    expect(updateLights).toHaveBeenCalledWith({
      theme_colour: '#3b6bff',
      theme_follows_picture: true,
    })
    wrapper.unmount()
    themeAccent.value = DEFAULT_APP_ACCENT
  })

  it('switching the picture-following accent carries over to the lights', async () => {
    useAppearanceStore().adaptiveAccent = true
    vi.mocked(getLights).mockResolvedValue({ ...PAIRED, theme_colour: themeColour() })
    vi.mocked(updateLights).mockImplementation(async (update) => ({ ...PAIRED, ...update }))
    const { useAuthStore } = await import('@/stores/auth')
    useAuthStore().authenticated = true
    const wrapper = mount(LightsButton, { global })
    await flushPromises()
    expect(updateLights).not.toHaveBeenCalled()
    useAppearanceStore().adaptiveAccent = false
    await flushPromises()
    expect(updateLights).toHaveBeenCalledWith({
      theme_colour: themeColour(),
      theme_follows_picture: false,
    })
    wrapper.unmount()
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
