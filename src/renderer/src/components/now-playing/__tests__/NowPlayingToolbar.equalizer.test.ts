// The phone reaches the speaker's equalizer from Now Playing's toolbar; the
// desktop has its own button in the player bar.
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

const FakeEqualizerButton = markRaw({
  name: 'FakeEqualizerButton',
  props: { compact: Boolean },
  template: '<button class="fake-equalizer" />',
})

function mountToolbar({ compact = true, equalizer = true, component = true } = {}) {
  const source = reactive({
    song: { id: 's' },
    radio: null,
    ui: { lyricsOpen: false, showVisualizer: false, artworkHidden: false },
    visualizer: { available: false },
    milkdrop: { available: false, active: false },
    backdrop: { isArtist: false, backgrounds: [] },
    capabilities: { equalizer, fullscreen: false, autoplay: false, debug: false },
    equalizerComponent: component ? FakeEqualizerButton : null,
  })
  return mount(NowPlayingToolbar, {
    props: { compact },
    global: { plugins: [vuetify, i18n], provide: { [nowPlayingSourceKey]: source } },
  })
}

describe("Now Playing's equalizer button", () => {
  it('is there on the phone while casting, opening the phone-sized dialog', () => {
    const button = mountToolbar().findComponent({ name: 'FakeEqualizerButton' })

    expect(button.exists()).toBe(true)
    expect(button.props('compact')).toBe(true)
  })

  it('is not there without a speaker to set', () => {
    expect(mountToolbar({ equalizer: false }).find('.fake-equalizer').exists()).toBe(false)
  })

  it('is not there on the desktop, which has its own in the player bar', () => {
    expect(mountToolbar({ compact: false }).find('.fake-equalizer').exists()).toBe(false)
  })

  it('is not there for a party guest, whose page has no equalizer', () => {
    expect(mountToolbar({ component: false }).find('.fake-equalizer').exists()).toBe(false)
  })
})
