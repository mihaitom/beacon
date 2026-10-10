import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { VAppBar } from 'vuetify/components'
import { i18n } from '@/i18n'
import { PHONE_LANDSCAPE_QUERY } from '@/composables/phoneLandscape'
import MobileLayout from '../MobileLayout.vue'

const vuetify = createVuetify({ components, directives })
const realMatchMedia = window.matchMedia

/** jsdom has no orientation to turn, so the one query that asks is answered
 * here; everything else stays unmatched. */
function holdPhone(sideways: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: sideways && query === PHONE_LANDSCAPE_QUERY,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

function mountLayout(routeName: string) {
  setActivePinia(createPinia())
  return mount(MobileLayout, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $route: { name: routeName }, $router: { push: () => {} } },
      stubs: {
        RouterView: true,
        MobileTabBar: true,
        MobilePlayerBar: true,
        CastTakeoverConfirmDialog: true,
        PartyModeButton: true,
      },
    },
  })
}

describe('the mobile shell on a phone held sideways', () => {
  afterEach(() => {
    window.matchMedia = realMatchMedia
  })

  it('hands Now Playing the whole screen', () => {
    holdPhone(true)
    const wrapper = mountLayout('m-now-playing')

    expect(wrapper.getComponent(VAppBar).props('modelValue')).toBe(false)
    expect(wrapper.getComponent({ name: 'MobileTabBar' }).props('active')).toBe(false)
  })

  it('keeps both bars on every other page, where they are the way around', () => {
    holdPhone(true)
    const wrapper = mountLayout('m-library')

    expect(wrapper.getComponent(VAppBar).props('modelValue')).toBe(true)
    expect(wrapper.getComponent({ name: 'MobileTabBar' }).props('active')).toBe(true)
  })

  it('keeps both bars on Now Playing held upright', () => {
    holdPhone(false)
    const wrapper = mountLayout('m-now-playing')

    expect(wrapper.getComponent(VAppBar).props('modelValue')).toBe(true)
    expect(wrapper.getComponent({ name: 'MobileTabBar' }).props('active')).toBe(true)
  })
})
