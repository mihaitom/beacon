// The Playback section's ReplayGain control is a segmented button group, not
// a dropdown. It was written as `<segmented-control>` but never registered in
// the component, so Vue rendered an unknown element and the choice silently
// disappeared — a wiring mistake only a mount catches.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import PlaybackSection from '../PlaybackSection.vue'
import { useTransitionsStore } from '@/stores/transitions'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

const vuetify = createVuetify({ components, directives })

describe('PlaybackSection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders the ReplayGain choice as the segmented button group', () => {
    const wrapper = mount(PlaybackSection, {
      global: { plugins: [vuetify, i18n] },
    })

    expect(wrapper.findComponent({ name: 'SegmentedControl' }).exists()).toBe(true)
  })

  it('opens the doc on what gets converted', async () => {
    const emit = vi.fn()
    const wrapper = mount(PlaybackSection, {
      global: {
        plugins: [vuetify, i18n],
        mocks: { $emitter: { emit, on: vi.fn(), off: vi.fn() } },
      },
    })
    const text = wrapper.vm.$t('help.conversion')
    await wrapper
      .findAllComponents({ name: 'VBtn' })
      .find((b) => b.text() === text)!
      .trigger('click')
    expect(emit).toHaveBeenCalledWith('openHelp', 'transcoding')
  })

  it('steps each crossfade length by its own amount', async () => {
    localStorage.clear()
    const transitions = useTransitionsStore()
    transitions.set({ mode: 'crossfade', crossfadeSeconds: 4, beatmixSeconds: 12 })
    const wrapper = mount(PlaybackSection, {
      global: { plugins: [vuetify, i18n] },
    })
    const [crossfade, beatmix] = wrapper.findAllComponents({ name: 'VNumberInput' })
    // The stepper acts on press (it repeats while held), not on click, and
    // captures the pointer, which jsdom has no notion of.
    Element.prototype.setPointerCapture ??= vi.fn()
    Element.prototype.releasePointerCapture ??= vi.fn()
    const increment = async (field: typeof crossfade) => {
      const button = field!.find('[data-testid="increment"]')
      await button.trigger('pointerdown')
      await button.trigger('pointerup')
    }

    await increment(crossfade)
    await increment(beatmix)
    expect(transitions.crossfadeSeconds).toBe(5)
    expect(transitions.beatmixSeconds).toBe(14)

    // A field emptied while typing keeps the length it had.
    beatmix!.vm.$emit('update:modelValue', null)
    expect(transitions.beatmixSeconds).toBe(14)
  })
})
