// The equalizer dialog: it sets whatever is playing (the speaker being cast
// to, a picked one of several, otherwise this device), this device's curve
// is heard as it moves, a speaker's is saved once the slider rests, "Apply
// now" restarts the song where it is (only needed without transitions),
// presets of one's own are saved and picked, and a phone says why it has
// no equalizer of its own. Not the copy or the layout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
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
vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

enableAutoUnmount(afterEach)

const vuetify = createVuetify({ components, directives })
const global = {
  plugins: [vuetify, i18n],
  stubs: { 'v-dialog': { template: '<div><slot /></div>' } },
}

const KITCHEN = { type: 'sonos' as const, name: 'Kitchen' }
const TV = { type: 'chromecast' as const, name: 'TV' }

interface Vm {
  draft: { enabled: boolean; gains: number[] }
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
    expect(vm.draft).toEqual({ enabled: true, gains: [...EQ_PRESETS.vocal] })
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

  it('needs no "Apply now" with transitions on, where the speaker hears it live', () => {
    const playback = usePlaybackStore()
    playback.setQueue([{ id: 'a', title: 'A' } as never], 0)
    playback.isPlaying = true
    useTransitionsStore().set({ mode: 'gapless' })
    const { vm } = openFor(KITCHEN)
    expect(vm.live).toBe(true)
    expect(vm.canApplyNow).toBe(false)
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
})
