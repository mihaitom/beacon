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
})
