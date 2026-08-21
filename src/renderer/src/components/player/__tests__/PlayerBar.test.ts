// PlayerBar.vue itself is now a thin orchestrator — it only owns the grid
// layout, the shared --player-bar-flank-width, and deciding
// volumeCollapsed off its own real rendered width. Everything else
// (song-info, the transport buttons, the seek bar, the toolbar's own
// mute/volume logic) has its own dedicated test file next to its own
// component. See PlayerBar.layout.browser.test.ts for the real-CSS-layout
// side of this (grid track sizing, centering, min-width) that jsdom can't
// meaningfully check at all.
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import PlayerBar from '../PlayerBar.vue'

const vuetify = createVuetify({ components, directives })

async function mountBar() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  // PlayerBar's <v-footer app> registers itself with Vuetify's layout
  // system, which only exists once a <v-app> ancestor has provided it —
  // mounting PlayerBar directly as the test root throws "Could not find
  // injected layout". A trivial host component gives it that ancestor;
  // `wrapper` below is what test code actually interacts with.
  const host = mount(
    { components: { PlayerBar }, template: '<v-app><player-bar /></v-app>' },
    {
      global: {
        plugins: [vuetify, i18n, router],
        stubs: {
          SongInfo: true,
          ControlContainer: true,
          PlayerToolbar: true,
        },
      },
    },
  )
  const wrapper = host.findComponent(PlayerBar)
  return { wrapper, host }
}

describe('PlayerBar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders song-info, control-container, and the toolbar', async () => {
    const { wrapper } = await mountBar()

    expect(wrapper.findComponent({ name: 'SongInfo' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'ControlContainer' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'PlayerToolbar' }).exists()).toBe(true)
  })

  it('passes its own volumeCollapsed state down to the toolbar as a prop', async () => {
    const { wrapper } = await mountBar()

    const vm = wrapper.vm as unknown as { volumeCollapsed: boolean }
    expect(wrapper.findComponent({ name: 'PlayerToolbar' }).props('volumeCollapsed')).toBe(false)

    vm.volumeCollapsed = true
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'PlayerToolbar' }).props('volumeCollapsed')).toBe(true)
  })
})
