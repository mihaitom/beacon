// The equalizer dialog: this device's curve is heard as it moves, a
// speaker's is saved once the slider rests, "Apply now" restarts the song
// where it is, and a phone says why it has no equalizer of its own. Not
// the copy or the layout.
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

interface Vm {
  draft: { enabled: boolean; gains: number[] }
  unavailable: boolean
  canApplyNow: boolean
  setGain: (index: number, gain: number) => void
  pickPreset: (name: string) => void
  applyNow: () => Promise<void>
}

function open(device: typeof KITCHEN | null = null) {
  const wrapper = mount(EqualizerDialog, { props: { modelValue: true, device }, global })
  return { wrapper, vm: wrapper.vm as unknown as Vm }
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
    const { vm } = open(KITCHEN)
    vm.setGain(0, 2)
    vm.setGain(0, 3)
    vm.setGain(0, 4)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledOnce()
    expect(store.speaker(KITCHEN).gains[0]).toBe(4)
  })

  it('saves what is still pending when it closes', async () => {
    const { wrapper, vm } = open(KITCHEN)
    vm.setGain(9, -5)
    await wrapper.setProps({ modelValue: false })
    expect(useEqualizerStore().speaker(KITCHEN).gains[9]).toBe(-5)
  })

  it('opens on what was stored', () => {
    useEqualizerStore().setSpeaker(KITCHEN, { enabled: true, gains: [...EQ_PRESETS.vocal] })
    const { vm } = open(KITCHEN)
    expect(vm.draft).toEqual({ enabled: true, gains: [...EQ_PRESETS.vocal] })
  })

  it('a preset replaces the curve and switches it on', () => {
    const { vm } = open()
    vm.pickPreset('treble')
    expect(useEqualizerStore().local).toEqual({ enabled: true, gains: [...EQ_PRESETS.treble] })
  })

  it('offers "Apply now" only for a speaker playing a song for this session', () => {
    const playback = usePlaybackStore()
    const { vm } = open(KITCHEN)
    expect(vm.canApplyNow).toBe(false)

    playback.setQueue([{ id: 'a', title: 'A' } as never], 0)
    playback.isPlaying = true
    useConnectStore().status = { targets: [KITCHEN] } as never
    expect(vm.canApplyNow).toBe(true)

    playback.radioStation = { id: 'r', name: 'R', streamUrl: 'x', homePageUrl: null }
    expect(vm.canApplyNow).toBe(false)
  })

  it('"Apply now" saves at once and restarts the song where it is', async () => {
    const playback = usePlaybackStore()
    const restart = vi.spyOn(playback, 'startCurrent').mockResolvedValue(true)
    playback.localPosition = 42
    const { vm } = open(KITCHEN)
    vm.setGain(2, 6)
    await vm.applyNow()
    expect(useEqualizerStore().speaker(KITCHEN).gains[2]).toBe(6)
    expect(restart).toHaveBeenCalledWith(42)
  })

  it("says so on a phone, where this device's playback has no graph to put it in", () => {
    ;(getAudioEngine() as unknown as { hasAnalyser: boolean }).hasAnalyser = false
    expect(open().vm.unavailable).toBe(true)
    // A speaker's curve is applied by connect, not here.
    expect(open(KITCHEN).vm.unavailable).toBe(false)
  })
})
