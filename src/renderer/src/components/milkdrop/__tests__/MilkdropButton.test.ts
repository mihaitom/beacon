// The Milkdrop button: it shows its menu open, and the menu keeps to Now
// Playing's own right edge - an open queue takes the window's.
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import MilkdropButton from '../MilkdropButton.vue'

const DialogStub = defineComponent({
  name: 'MilkdropDialog',
  props: { modelValue: Boolean, current: String, rightInset: Number },
  render: () => h('div'),
})

const NowPlaying = defineComponent({
  components: { MilkdropButton },
  template: '<div class="now-playing"><milkdrop-button /></div>',
})

function mountIn(nowPlayingRight: number) {
  const wrapper = mount(NowPlaying, {
    attachTo: document.body,
    global: {
      plugins: [createVuetify({ components, directives }), i18n],
      stubs: { MilkdropDialog: DialogStub },
    },
  })
  const nowPlaying = wrapper.get('.now-playing').element as HTMLElement
  nowPlaying.getBoundingClientRect = () => ({ right: nowPlayingRight }) as DOMRect
  return wrapper
}

describe('MilkdropButton', () => {
  it('opens its menu beside the queue, and shows it open', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true })
    const wrapper = mountIn(1200)
    const button = wrapper.get('button')
    expect(button.classes()).not.toContain('text-primary')

    await button.trigger('click')
    const dialog = wrapper.findComponent(DialogStub)
    expect(dialog.props('modelValue')).toBe(true)
    expect(dialog.props('rightInset')).toBe(400)
    expect(button.classes()).toContain('text-primary')
    wrapper.unmount()
  })
})
