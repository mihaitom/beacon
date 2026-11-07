// The toolbar's equalizer button is lit while a curve is changing what is
// heard - the speaker's while casting, this device's otherwise.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useEqualizerStore } from '@/stores/equalizer'
import { useConnectStore } from '@/stores/connect'
import { getAudioEngine } from '@/services/audioEngine'
import { EQ_PRESETS } from '@/services/equalizer'
import EqualizerButton from '../EqualizerButton.vue'

vi.mock('@/services/audioEngine', () => {
  const engine = { hasAnalyser: true, setEqualizer: vi.fn() }
  return { getAudioEngine: () => engine }
})
vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/services/connect/playback', () => ({
  updateEqualizers: vi.fn().mockResolvedValue(undefined),
}))

const vuetify = createVuetify({ components, directives })
const KITCHEN = { type: 'sonos' as const, name: 'Kitchen' }
const bass = () => ({ enabled: true, gains: [...EQ_PRESETS.bass] })

function active(): boolean {
  const wrapper = mount(EqualizerButton, {
    global: { plugins: [vuetify, i18n], stubs: { EqualizerDialog: true } },
  })
  return (wrapper.vm as unknown as { active: boolean }).active
}

describe('EqualizerButton', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    ;(getAudioEngine() as unknown as { hasAnalyser: boolean }).hasAnalyser = true
  })

  it("is lit by this device's curve when nothing is cast", () => {
    expect(active()).toBe(false)
    useEqualizerStore().setLocal(bass())
    expect(active()).toBe(true)
  })

  it("follows the speaker's curve while casting, not this device's", () => {
    useEqualizerStore().setLocal(bass())
    useConnectStore().status = { targets: [KITCHEN] } as never
    expect(active()).toBe(false)
    useEqualizerStore().setSpeaker(KITCHEN, bass())
    expect(active()).toBe(true)
  })

  it("is not lit on a phone, where this device's curve does nothing", () => {
    useEqualizerStore().setLocal(bass())
    ;(getAudioEngine() as unknown as { hasAnalyser: boolean }).hasAnalyser = false
    expect(active()).toBe(false)
  })
})
