// The phone reaches the room lights from Now Playing's toolbar - with the
// computer shut down it is the only way to stop them. The desktop has its
// own button in the player bar.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { markRaw, reactive } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import NowPlayingToolbar from '../NowPlayingToolbar.vue'
import { nowPlayingSourceKey } from '../source'

const vuetify = createVuetify({ components, directives })

const FakeLightsButton = markRaw({
  name: 'FakeLightsButton',
  props: { compact: Boolean },
  template: '<button class="fake-lights" />',
})

function mountToolbar({ compact = true, component = true } = {}) {
  const source = reactive({
    song: { id: 's' },
    radio: null,
    ui: { lyricsOpen: false, showVisualizer: false, artworkHidden: false },
    visualizer: { available: false },
    milkdrop: { available: false, active: false },
    backdrop: { isArtist: false, backgrounds: [] },
    capabilities: { equalizer: false, fullscreen: false, autoplay: false, debug: false },
    equalizerComponent: null,
    lightsComponent: component ? FakeLightsButton : null,
  })
  return mount(NowPlayingToolbar, {
    props: { compact },
    global: { plugins: [vuetify, i18n], provide: { [nowPlayingSourceKey]: source } },
  })
}

describe("Now Playing's lights button", () => {
  it('is there on the phone, opening the phone-sized dialog', () => {
    const button = mountToolbar().findComponent({ name: 'FakeLightsButton' })

    expect(button.exists()).toBe(true)
    expect(button.props('compact')).toBe(true)
  })

  it('is not there on the desktop, which has its own in the player bar', () => {
    expect(mountToolbar({ compact: false }).find('.fake-lights').exists()).toBe(false)
  })

  it('is not there for a party guest, whose page has no lights', () => {
    expect(mountToolbar({ component: false }).find('.fake-lights').exists()).toBe(false)
  })
})
