// The equalizer dialog: it sets whatever is playing (the speaker being cast
// to, a picked one of several, otherwise this device), this device's curve
// is heard as it moves, a speaker's is saved once the slider rests, "Apply
// now" restarts the song where it is (only needed without transitions),
// presets of one's own are saved and picked, a headphone profile is
// imported and played in place of the bands, and a phone says why it has
// no equalizer of its own. Not the copy or the layout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useEqualizerStore } from '@/stores/equalizer'
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import { useTransitionsStore } from '@/stores/transitions'
import { getAudioEngine } from '@/services/audioEngine'
import { EQ_PRESETS } from '@/services/equalizer'
import EqualizerDialog from '../EqualizerDialog.vue'

vi.mock('@/services/audioEngine', () => {
  const engine = { hasAnalyser: true, setEqualizer: vi.fn() }
  return { getAudioEngine: () => engine }
})
const castEvents = vi.hoisted(() => ({ started: 0, stopped: 0 }))
vi.mock('@/services/connect/visualizer', () => ({
  VisualizerEventSource: class {
    onFrame = null
    start() {
      castEvents.started++
    }
    stop() {
      castEvents.stopped++
    }
  },
}))
vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

const vuetify = createVuetify({ components, directives })
const global = {
  plugins: [vuetify, i18n],
  stubs: { 'v-dialog': { template: '<div><slot /></div>' } },
}

const KITCHEN = { type: 'sonos' as const, name: 'Kitchen' }
const TV = { type: 'chromecast' as const, name: 'TV' }

interface Vm {
  draft: { enabled: boolean; gains: number[]; profile: { name: string } | null }
  importProblem: string
  importFile: (event: Event) => Promise<void>
  device: typeof KITCHEN | null
  unavailable: boolean
  canApplyNow: boolean
  live: boolean
  selectedPreset: string
  presetName: string
  setGain: (index: number, gain: number) => void
  pickPreset: (name: string) => void
  selectTarget: (key: string) => void
  startNaming: () => void
  savePreset: () => void
  applyNow: () => Promise<void>
  $nextTick: () => Promise<void>
}

function castTo(...targets: (typeof KITCHEN | typeof TV)[]) {
  useConnectStore().status = { targets } as never
}

/** Opens the dialog for whatever `castTo()` set up - this device if
 * nothing. */
function open() {
  const wrapper = mount(EqualizerDialog, { props: { modelValue: true }, global })
  return { wrapper, vm: wrapper.vm as unknown as Vm }
}

function openFor(device: typeof KITCHEN | null) {
  if (device) castTo(device)
  return open()
}

describe('EqualizerDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
    vi.useFakeTimers()
    castEvents.started = castEvents.stopped = 0
    ;(getAudioEngine() as unknown as { hasAnalyser: boolean }).hasAnalyser = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("plays this device's curve the moment a band moves, and switches it on", () => {
    const { vm } = open()
    vm.setGain(1, 4)
    expect(useEqualizerStore().local.enabled).toBe(true)
    expect(useEqualizerStore().local.gains[1]).toBe(4)
    expect(getAudioEngine().setEqualizer).toHaveBeenLastCalledWith([
      expect.objectContaining({ frequency: 62, gain: 4 }),
    ])
  })

  it("saves a speaker's curve once the slider rests, not on every step", () => {
    const store = useEqualizerStore()
    const save = vi.spyOn(store, 'setSpeaker')
    const { vm } = openFor(KITCHEN)
    vm.setGain(0, 2)
    vm.setGain(0, 3)
    vm.setGain(0, 4)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledOnce()
    expect(store.speaker(KITCHEN).gains[0]).toBe(4)
  })

  it('saves what is still pending when it closes', async () => {
    const { wrapper, vm } = openFor(KITCHEN)
    vm.setGain(9, -5)
    await wrapper.setProps({ modelValue: false })
    expect(useEqualizerStore().speaker(KITCHEN).gains[9]).toBe(-5)
  })

  it('opens on what was stored', () => {
    useEqualizerStore().setSpeaker(KITCHEN, { enabled: true, gains: [...EQ_PRESETS.vocal] })
    const { vm } = openFor(KITCHEN)
    expect(vm.draft).toEqual({ enabled: true, gains: [...EQ_PRESETS.vocal], profile: null })
  })

  it('a preset replaces the curve and switches it on', () => {
    const { vm } = open()
    vm.pickPreset('treble')
    expect(useEqualizerStore().local).toEqual({ enabled: true, gains: [...EQ_PRESETS.treble] })
  })

  it('offers "Apply now" only for a speaker playing a song for this session', () => {
    const playback = usePlaybackStore()
    const { vm } = openFor(KITCHEN)
    expect(vm.canApplyNow).toBe(false)

    playback.setQueue([{ id: 'a', title: 'A' } as never], 0)
    playback.isPlaying = true
    expect(vm.canApplyNow).toBe(true)

    playback.radioStation = { id: 'r', name: 'R', streamUrl: 'x', homePageUrl: null }
    expect(vm.canApplyNow).toBe(false)
  })

  it('offers to hear it now with transitions on too, where a change otherwise waits for the buffer', () => {
    const playback = usePlaybackStore()
    playback.setQueue([{ id: 'a', title: 'A' } as never], 0)
    playback.isPlaying = true
    useTransitionsStore().set({ mode: 'gapless' })
    const { vm } = openFor(KITCHEN)
    expect(vm.live).toBe(true)
    expect(vm.canApplyNow).toBe(true)
  })

  it('sets the speaker being cast to, and this device when nothing is', async () => {
    const { vm } = open()
    expect(vm.device).toBeNull()
    vm.setGain(0, 3)
    expect(useEqualizerStore().local.gains[0]).toBe(3)

    castTo(KITCHEN)
    await vm.$nextTick()
    expect(vm.device).toEqual(KITCHEN)
    vm.setGain(0, 5)
    vi.advanceTimersByTime(1000)
    expect(useEqualizerStore().speaker(KITCHEN).gains[0]).toBe(5)
    expect(useEqualizerStore().local.gains[0]).toBe(3)
  })

  it('casting to several, each speaker is picked and keeps its own curve', async () => {
    castTo(KITCHEN, TV)
    const { vm } = open()
    expect(vm.device).toEqual(KITCHEN)
    vm.setGain(1, 4)
    // Picked before the first one's save is due: that still lands on it.
    vm.selectTarget('chromecast:TV')
    await vm.$nextTick()
    expect(vm.device).toEqual(TV)
    expect(vm.draft.gains[1]).toBe(0)
    vm.setGain(1, -4)
    vi.advanceTimersByTime(1000)
    const store = useEqualizerStore()
    expect(store.speaker(KITCHEN).gains[1]).toBe(4)
    expect(store.speaker(TV).gains[1]).toBe(-4)
  })

  it('saves a curve as a preset of its own, which can then be picked', () => {
    const { vm } = open()
    vm.setGain(3, 7)
    expect(vm.selectedPreset).toBe('custom')
    vm.startNaming()
    vm.presetName = '  Kitchen radio  '
    vm.savePreset()
    expect(useEqualizerStore().presets).toEqual([
      { name: 'Kitchen radio', gains: [0, 0, 0, 7, 0, 0, 0, 0, 0, 0] },
    ])
    expect(vm.selectedPreset).toBe('custom:Kitchen radio')

    vm.pickPreset('flat')
    vm.pickPreset('custom:Kitchen radio')
    expect(useEqualizerStore().local.gains[3]).toBe(7)
  })

  describe('a headphone profile', () => {
    const PROFILE_TEXT = [
      'Preamp: -6.4 dB',
      'Filter 1: ON LSC Fc 105 Hz Gain 6.5 dB Q 0.70',
      'Filter 2: ON PK Fc 2900 Hz Gain 4.1 dB Q 2.20',
    ].join('\n')
    const FILTERS = [
      { frequency: 105, gain: 6.5, q: 0.7, type: 'lowshelf' },
      { frequency: 2900, gain: 4.1, q: 2.2 },
    ]

    /** What picking `text` as `name` in the file chooser does. */
    async function importAs(vm: Vm, name: string, text: string): Promise<void> {
      const input = document.createElement('input')
      Object.defineProperty(input, 'files', { value: [new File([text], name)] })
      await vm.importFile({ target: input } as unknown as Event)
    }

    it('is kept with the own presets and played straight away, as imported', async () => {
      const { vm } = open()
      await importAs(vm, 'Sennheiser HD 600 ParametricEQ.txt', PROFILE_TEXT)

      const store = useEqualizerStore()
      expect(store.presets.map((p) => [p.name, p.profile?.filters])).toEqual([
        ['Sennheiser HD 600', FILTERS],
      ])
      expect(store.local.enabled).toBe(true)
      expect(getAudioEngine().setEqualizer).toHaveBeenLastCalledWith(FILTERS)
      expect(vm.selectedPreset).toBe('custom:Sennheiser HD 600')
    })

    it('shows its curve without points to drag', async () => {
      const { wrapper, vm } = open()
      expect(wrapper.findAll('[role="slider"]')).not.toHaveLength(0)
      await importAs(vm, 'HD 600.txt', PROFILE_TEXT)
      await vm.$nextTick()
      expect(wrapper.findAll('[role="slider"]')).toHaveLength(0)
    })

    it('gives way to the bands again when a preset is picked', async () => {
      const { vm } = open()
      await importAs(vm, 'HD 600.txt', PROFILE_TEXT)
      vm.pickPreset('bass')
      expect(useEqualizerStore().local.profile).toBeUndefined()
      expect(useEqualizerStore().local.gains).toEqual([...EQ_PRESETS.bass])
      vm.pickPreset('custom:HD 600')
      expect(useEqualizerStore().local.profile?.filters).toEqual(FILTERS)
    })

    it("is set for a speaker as its curve, and sent as the profile's filters", async () => {
      castTo(KITCHEN)
      const { wrapper, vm } = open()
      await importAs(vm, 'HD 600.txt', PROFILE_TEXT)
      await wrapper.setProps({ modelValue: false })
      expect(useEqualizerStore().castPayload).toEqual({ 'sonos:Kitchen': FILTERS })
    })

    it('says what is wrong with a file it cannot read, and changes nothing', async () => {
      const { vm } = open()
      await importAs(vm, 'graphic.txt', 'GraphicEQ: 20 -3; 40 -2')
      expect(vm.importProblem).not.toBe('')
      expect(useEqualizerStore().presets).toEqual([])
      expect(useEqualizerStore().local.enabled).toBe(false)
    })
  })

  it('"Apply now" saves at once and restarts the song where it is', async () => {
    const playback = usePlaybackStore()
    const restart = vi.spyOn(playback, 'startCurrent').mockResolvedValue(true)
    playback.localPosition = 42
    const { vm } = openFor(KITCHEN)
    vm.setGain(2, 6)
    await vm.applyNow()
    expect(useEqualizerStore().speaker(KITCHEN).gains[2]).toBe(6)
    expect(restart).toHaveBeenCalledWith(42)
  })

  it("says so on a phone, where this device's playback has no graph to put it in", () => {
    ;(getAudioEngine() as unknown as { hasAnalyser: boolean }).hasAnalyser = false
    expect(open().vm.unavailable).toBe(true)
    // A speaker's curve is applied by connect, not here.
    expect(openFor(KITCHEN).vm.unavailable).toBe(false)
  })

  it("watches the speaker's music while casting, and lets go when closed", async () => {
    const playback = usePlaybackStore()
    playback.setQueue([{ id: 'a', title: 'A' } as never], 0)
    playback.isPlaying = true
    const { wrapper } = openFor(KITCHEN)
    expect(castEvents.started).toBe(1)
    await wrapper.setProps({ modelValue: false })
    expect(castEvents.stopped).toBe(1)
  })

  it("lets go of the speaker's music when it goes away while open", () => {
    const playback = usePlaybackStore()
    playback.setQueue([{ id: 'a', title: 'A' } as never], 0)
    playback.isPlaying = true
    const { wrapper } = openFor(KITCHEN)
    wrapper.unmount()
    expect(castEvents.stopped).toBe(1)
  })

  it('does not watch a speaker that is not playing', () => {
    openFor(KITCHEN)
    expect(castEvents.started).toBe(0)
  })
})
