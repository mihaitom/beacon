import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useEqualizerStore } from '../equalizer'
import { useConnectStore } from '../connect'
import { pushAccountSettings } from '@/services/connect/accountSettings'
import { updateEqualizers } from '@/services/connect/playback'
import { getAudioEngine } from '@/services/audioEngine'
import { EQ_PRESETS, EQ_Q } from '@/services/equalizer'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/services/connect/playback', () => ({
  updateEqualizers: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/services/audioEngine', () => {
  const engine = { setEqualizer: vi.fn() }
  return { getAudioEngine: () => engine }
})

const KITCHEN = { type: 'sonos' as const, name: 'Kitchen' }
const bass = () => ({ enabled: true, gains: [...EQ_PRESETS.bass] })

describe('equalizer store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('plays this device flat until told otherwise', () => {
    const store = useEqualizerStore()
    store.applyLocal()
    expect(getAudioEngine().setEqualizer).toHaveBeenLastCalledWith([])
  })

  it("puts this device's curve into the graph and keeps it on this device", () => {
    const store = useEqualizerStore()
    store.setLocal(bass())

    expect(getAudioEngine().setEqualizer).toHaveBeenLastCalledWith([
      { frequency: 31, gain: 6, q: EQ_Q },
      { frequency: 62, gain: 5, q: EQ_Q },
      { frequency: 125, gain: 4, q: EQ_Q },
      { frequency: 250, gain: 2, q: EQ_Q },
    ])
    expect(pushAccountSettings).not.toHaveBeenCalled()

    store.local = { enabled: false, gains: [...EQ_PRESETS.flat] }
    store.reloadForAccount()
    expect(store.local).toEqual(bass())
  })

  it("syncs a speaker's curve to the account", async () => {
    const store = useEqualizerStore()
    store.setSpeaker(KITCHEN, bass())

    expect(store.speaker(KITCHEN)).toEqual(bass())
    await vi.waitFor(() =>
      expect(pushAccountSettings).toHaveBeenCalledWith({
        speakerEqualizers: { 'sonos:Kitchen': bass() },
      }),
    )
  })

  it('tells the session about it while casting, and only then', async () => {
    const store = useEqualizerStore()
    store.setSpeaker(KITCHEN, bass())
    await vi.waitFor(() => expect(pushAccountSettings).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updateEqualizers).not.toHaveBeenCalled()

    useConnectStore().status = { targets: [KITCHEN] } as never
    store.setSpeaker(KITCHEN, { ...bass(), gains: [...EQ_PRESETS.treble] })
    await vi.waitFor(() =>
      expect(updateEqualizers).toHaveBeenCalledWith({
        'sonos:Kitchen': [
          { frequency: 2000, gain: 1, q: EQ_Q },
          { frequency: 4000, gain: 3, q: EQ_Q },
          { frequency: 8000, gain: 5, q: EQ_Q },
          { frequency: 16000, gain: 6, q: EQ_Q },
        ],
      }),
    )
  })

  it('casts only the speakers whose curve does something', () => {
    const store = useEqualizerStore()
    store.setSpeakers({
      'sonos:Kitchen': bass(),
      'sonos:Office': { enabled: false, gains: [...EQ_PRESETS.bass] },
      'chromecast:TV': { enabled: true, gains: [...EQ_PRESETS.flat] },
    })
    expect(Object.keys(store.castPayload)).toEqual(['sonos:Kitchen'])
  })

  it('reads a speaker it has never seen as flat and off', () => {
    expect(useEqualizerStore().speaker(KITCHEN)).toEqual({
      enabled: false,
      gains: [...EQ_PRESETS.flat],
    })
  })
})
